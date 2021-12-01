"use strict";

const SMTPConnection = require("nodemailer/lib/smtp-connection");
const _ = require("lodash");
const dns = require("dns");
const isIp = require("is-ip");
const pify = require("pify");
const smtpAddressParser = require("smtp-address-parser");

import { EventEmitter } from "events";

/**
 * A typeguarded version of `instanceof Error` for NodeJS.
 * @author Joseph JDBar Barron
 * @link https://dev.to/jdbar
 */
export function instanceOfNodeError<T extends new (...args: any) => Error>(
    value: Error,
    errorType: T
): value is InstanceType<T> & NodeJS.ErrnoException {
    return value instanceof errorType;
}

function wrapErrorEvent(target: EventEmitter, other: () => Promise<any>, logger: any): Promise<unknown> {
    return new Promise(function (resolve, reject) {
        target.on("error", (err) => {
            logger.error(`Captured a socket error! ${err}`);
            reject(err);
        });
        other()
            .then((r) => resolve(r))
            .catch((e) => reject(e));
    });
}

/**
 * Returns an RFC-5321 section 5.1. "implicit MX" record if the domain
 * has any address records.
 */
async function implicitMX(domain: string) {
    try {
        await Promise.any([dns.promises.resolve4(domain), dns.promises.resolve6(domain)]);
        return [{ priority: 0, exchange: domain }];
    } catch (err: any) {
        if (instanceOfNodeError(err, Error)) {
            if (err.code === "ENODATA" || err.code === "ENOTFOUND") {
                return [];
            } else {
                throw err; // anything else, including code==="ETIMEOUT"
            }
        } else {
            throw err; // throwing non Error, should never happen
        }
    }
}

/**
 * Returns the ordered list of Mail eXchangers for a domain.
 */
async function getMXs(domain: string) {
    try {
        const mx = await dns.promises.resolveMx(domain);
        if (mx.length === 0) {
            return await implicitMX(domain);
        }
        return _.sortBy(mx, ["priority", Math.random]);
    } catch (err: any) {
        if (instanceOfNodeError(err, Error)) {
            if (err.code === "ENODATA" || err.code === "ENOTFOUND") {
                return await implicitMX(domain);
            } else {
                throw err; // anything else, including code==="ETIMEOUT", perhaps thrown from implicitMX
            }
        } else {
            throw err; // throwing non Error, should never happen
        }
    }
}

export function addressFromLiteral(literal: string): string {
    const m6 = literal.match(/\[IPv6:([^\]]*)\]/i);
    if (m6) return m6[1];
    const m4 = literal.match(/\[([^\]]*)\]/);
    if (m4) return m4[1];
    throw new Error(`${literal} is not an address literal`);
}

const ipv4re = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})/;

export function isLoopback(addr: string): boolean {
    if (isIp.v4(addr)) {
        const a = addr.match(ipv4re);

        if (!a) throw new Error(`${addr} not a valid IPv4 address`);

        return a[1] === "127";
    }
    if (isIp.v6(addr)) {
        // FIXME, there are multiple ways to write ::1
        return addr === "::1";
    }
    throw new Error(`${addr} is not an IP address`);
}

export function isPrivate(addr: string): boolean {
    if (isIp.v4(addr)) {
        const a = addr.match(ipv4re);

        if (!a) throw new Error(`${addr} not a valid IPv4 address`);

        if (a[1] == "10") return true;

        if (a[1] == "172") {
            const oct = Number(a[2]);
            return 16 <= oct && oct <= 31;
        }

        return a[1] == "192" && a[2] == "168";
    }
    if (isIp.v6(addr)) {
        // https://en.wikipedia.org/wiki/Private_network#Private_IPv6_addresses
        return addr.toLowerCase().startsWith("fd");
    }
    throw new Error(`${addr} is not an IP address`);
}

type Content = string | Buffer | Uint8Array;

export async function sendMessage(
    name: string,
    mailFrom: string,
    rcptTo: string,
    content: Content,
    logger: any,
    tls: any
) {
    const from_parsed = mailFrom !== "<>" ? smtpAddressParser.parse(mailFrom) : {};
    const to_parsed = smtpAddressParser.parse(rcptTo);

    const envelope = {
        from: mailFrom,
        to: rcptTo,
    };

    if (to_parsed.domainPart.AddressLiteral) {
        // FIXME, should allow this at some point.
        var err: { [k: string]: any } = new Error("Domain is an address literal");
        err.response = "Domain is an address literal";
        err.responseCode = 500;
        throw err;
    }

    if (to_parsed.domainPart.DomainName.split(".").length < 2) {
        var err: { [k: string]: any } = new Error("Domain not fully qualified");
        err.response = "Domain not fully qualified";
        err.responseCode = 500;
        throw err;
    }

    const mxRecords = await getMXs(to_parsed.domainPart.DomainName);

    if (mxRecords.length === 0) {
        var err: { [k: string]: any } = new Error("No MX (or A or AAAA) record");
        err.response = "No MX or A or AAAA";
        err.responseCode = 500;
        throw err;
    }

    if (mxRecords.length === 1 && mxRecords[0].priority === 0 && mxRecords[0].exchange === "") {
        var err: { [k: string]: any } = new Error("Null MX record");
        err.response = "Null MX";
        err.responseCode = 500;
        throw err;
    }

    for (const mxRecord of mxRecords) {
        const host = mxRecord.exchange;

        const connection = new SMTPConnection({
            port: 25,
            host: host,
            name: name,
            secure: false, // connect in plain-text
            opportunisticTLS: true, // upgrade using STARTTLS
            socketTimeout: 30 * 1000, // 30 seconds
            transactionLog: true,
            tls,
        });

        const connect = pify(connection.connect.bind(connection));
        const send = pify(connection.send.bind(connection));
        try {
            const result = await wrapErrorEvent(
                connection,
                async () => {
                    logger.debug(`About to connect to host ${host}`);
                    await connect();
                    logger.debug(`Connected, about to send a message from ${envelope.from} to ${envelope.to}`);
                    const sent = await send(envelope, content);
                    logger.debug(`Message sent successfuly`);
                    return { ...sent, host };
                },
                logger
            );
            connection.quit();
            return result;
        } catch (e) {
            logger.error(`${JSON.stringify(e)}`);
            connection.quit();
            var err: { [k: string]: any } = new Error("Delivery attempt failed");
            err.response = "Delivery attempt failed";
            err.responseCode = 500;
            throw err;
        }
    }

    throw new Error("Could not deliver message.");
}
