"use strict";

const SMTPConnection = require("nodemailer/lib/smtp-connection");
const _ = require("lodash");
const dns = require("dns");
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
 * Returns the ordered list of Mail eXchangers for a domain, including
 * an implicit record if no others found in DNS.
 */
async function getMXs(domain: string) {
    try {
        const mx = await dns.promises.resolveMx(domain);
        return _.sortBy(mx, ["priority", Math.random]);
    } catch (err_mx: any) {
        if (instanceOfNodeError(err_mx, Error)) {
            if (err_mx.code === "ENODATA" || err_mx.code === "ENOTFOUND") {
                try {
                    await Promise.any([dns.promises.resolve4(domain), dns.promises.resolve6(domain)]);
                    // RFC-5321 section 5.1. "implicit MX"
                    return [{ priority: 0, exchange: domain }];
                } catch (e_addr: any) {
                    if (instanceOfNodeError(e_addr, Error)) {
                        if (e_addr.code === "ENODATA" || e_addr.code === "ENOTFOUND") {
                            // No 'A' or 'AAAA' record
                            return [];
                        }
                    } else {
                        throw e_addr; // anything else, including code==="ETIMEOUT"
                    }
                }
            } else {
                throw err_mx; // anything else, including code==="ETIMEOUT"
            }
        } else {
            throw err_mx; // throwing non Error should never happen
        }
    }
}

export async function sendEmail(name: string, mailFrom: string, rcptTo: string, content: any, logger: any, tls: any) {
    const from_parsed = smtpAddressParser.parse(mailFrom);
    const to_parsed = smtpAddressParser.parse(rcptTo);

    const envelope = {
        from: mailFrom,
        to: rcptTo,
    };

    if (to_parsed.AddressLiteral) {
        throw new Error("Domain is an address literal.");
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
            logger.debug(`${JSON.stringify(e)}`);
        }

        connection.quit();
    }

    throw new Error("Could not deliver message.");
}
