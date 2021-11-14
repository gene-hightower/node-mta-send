"use strict";

const SMTPConnection = require("nodemailer/lib/smtp-connection");
const _ = require("lodash");
const dns = require("dns");
const isIp = require("is-ip");
const pify = require("pify");
const smtpAddressParser = require("smtp-address-parser");

import {EventEmitter} from 'events';

// function isError(error: any): error is NodeJS.ErrnoException { return error instanceof Error; }

function wrapErrorEvent(target: EventEmitter, other: () => Promise<any>, logger: any) : Promise<unknown>
{
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
async function getMXs(domain: string)
{
    try {
        const mx = await dns.promises.resolveMx(domain);
        return _.sortBy(mx, ["priority", Math.random]);
    } catch (e: any) {

            if (e.code === "ENODATA" || e.code === "ENOTFOUND") {
                try {
                    await Promise.any([dns.promises.resolve4(domain), dns.promises.resolve6(domain)]);
                    // RFC-5321 section 5.1. "implicit MX"
                    return [{ priority: 0, exchange: domain }];
                }
                catch (e) {
                    // No 'A' record
                    return [];
                }
            } else if (e.errno === "ETIMEOUT") {
                return [];
            } else {
                throw e;
            }

    }
}

export async function sendOutgoingEmail(name: string,
                                        mailFrom: string,
                                        rcptTo: string,
                                        content: any,
                                        logger : any,
                                        tls : any)
{
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
        var err: {[k: string]: any} = new Error("No MX (or A or AAAA) record");
        err.response = "No MX or A or AAAA";
        err.responseCode = 500;
        throw err;
    }

    if (mxRecords.length === 1 && mxRecords[0].priority === 0 && mxRecords[0].exchange === "") {
        var err: {[k: string]: any} = new Error("Null MX record");
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
            secure: false,
            transactionLog: true,
            opportunisticTLS: true,
            socketTimeout: 2 * 60 * 1000,
            tls,
        });

        const connect = pify(connection.connect.bind(connection));
        const send = pify(connection.send.bind(connection));
        try {
            if (!isIp(host)) {
                // attempt to resolve host early, to avoid connecting to non existing host
                await dns.promises.resolve4(host);
            }
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
        } catch (e: any) {
            const error_message = `Error in outbound from ${envelope.from} to ${envelope.to}: ${JSON.stringify(e)}`;
            logger.debug(error_message);
        }

        connection.quit();
    }
 
   throw new Error("Could not deliver message.");
}

