import assert from "node:assert/strict";
import test from "node:test";
import { rewriteLocation, rewriteSetCookie } from "../src/proxy";

test("rewriteSetCookie removes the upstream domain", () => {
  const cookie =
    "wr_skey=secret; Domain=.weread.qq.com; Path=/; HttpOnly; SameSite=Lax";
  const result = rewriteSetCookie(cookie);

  assert.doesNotMatch(result, /domain=/i);
  assert.match(result, /HttpOnly/i);
  assert.match(result, /Secure/i);
  assert.match(result, /SameSite=None/i);
});

test("rewriteSetCookie does not duplicate Secure", () => {
  const result = rewriteSetCookie("wr_vid=123; Path=/; Secure; SameSite=None");
  assert.equal((result.match(/Secure/gi) ?? []).length, 1);
  assert.equal((result.match(/SameSite=None/gi) ?? []).length, 1);
});

test("rewriteLocation keeps navigation inside the proxy", () => {
  assert.equal(
    rewriteLocation("https://weread.qq.com/web/reader/abc?chapter=2#mark"),
    "/web/reader/abc?chapter=2#mark"
  );
});

test("rewriteLocation leaves third-party login redirects unchanged", () => {
  assert.equal(
    rewriteLocation("https://open.weixin.qq.com/connect/qrconnect"),
    "https://open.weixin.qq.com/connect/qrconnect"
  );
});
