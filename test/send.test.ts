"use strict";

const dedent = require("dedent");
const fs = require("fs");
const strftime = require("strftime");

import { base32Encode } from "@ctrl/ts-base32";

const base32Type = "Crockford"; // <https://www.crockford.com/base32.html>

const { sendMessage } = require("../src/main.js");

jest.setTimeout(10000);

describe("send some mail", () => {
    it("send", async () => {
        const logger = { log: console.log, debug: console.debug, error: console.error };

        const tls = {
            key: fs.readFileSync("key.pem"),
            cert: fs.readFileSync("cert.pem"),
            rejectUnauthorized: false,
            minVersion: "TLSv1",
        };

        const from_addr = "nobody@digilicious.com";
        const to_addr = `nobody@mailinator.com`;

        const ut = Math.trunc(Date.now() / 1000); // "unix" time

        const rnd = (Math.random() + "").split(".")[1];

        const date = strftime("%a, %d %b %Y %H:%M:%S %z");

        const host = "digilicious.com";

        const msg_str = dedent`
            Message-ID: <${ut}.${rnd}@${host}>
            Date: ${date}
            From: "Gene Hightower" <${from_addr}>
            To: "Gene Hightower" <${to_addr}>
            Subject: foo bar baz
            MIME-Version: 1.0
            Content-Language: en-US
            Content-Type: text/plain; charset=UTF-8

            Some message body.`;

        const result = await sendMessage(host, from_addr, to_addr, msg_str, logger, tls);

        console.log(result);
    });
});
