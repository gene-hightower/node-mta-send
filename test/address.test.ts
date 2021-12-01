"use strict";

const { addressFromLiteral, isLoopback, isPrivate } = require("../src/main.js");

describe("good addresses pass", () => {
    it("extract IP addresses from address literals", () => {
        const a4 = addressFromLiteral("[127.0.0.1]");
        expect(a4).toEqual("127.0.0.1");
        const a6 = addressFromLiteral("[IPv6:::1]");
        expect(a6).toEqual("::1");
    });

    it("check for loopback addresses", () => {
        expect(isLoopback("127.0.0.1")).toEqual(true);
        expect(isLoopback("192.168.0.1")).toEqual(false);
        expect(isLoopback("::1")).toEqual(true);
        expect(isLoopback("fd12:3456:789a:1::1")).toEqual(false);
    });

    it("check private unroutable addresses", () => {
        expect(isPrivate("10.0.0.1")).toEqual(true);
        expect(isPrivate("172.16.0.1")).toEqual(true);
        expect(isPrivate("192.168.0.1")).toEqual(true);
        expect(isPrivate("fd12:3456:789a:1::1")).toEqual(true);
        expect(isPrivate("9.9.9.9")).toEqual(false);
    });
});
