import assert from "node:assert/strict";
import test from "node:test";
import type * as vscode from "vscode";
import {
  normalizeReaderPath,
  rewriteLocation,
  rewriteSetCookie
} from "../src/proxy";
import {
  mergeCookieHeaders,
  parseCookieHeader,
  parseSetCookie,
  SessionVault
} from "../src/session";

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

test("parseSetCookie preserves values containing equals characters", () => {
  assert.deepEqual(parseSetCookie("wr_skey=a=b=c; Path=/; HttpOnly"), {
    name: "wr_skey",
    value: "a=b=c",
    remove: false
  });
});

test("parseSetCookie recognizes cookie deletion", () => {
  assert.equal(
    parseSetCookie("wr_vid=; Path=/; Max-Age=0")?.remove,
    true
  );
});

test("mergeCookieHeaders prefers fresh browser cookies", () => {
  const merged = mergeCookieHeaders(
    "wr_vid=old; wr_skey=saved",
    "wr_vid=fresh; theme=dark"
  );
  const cookies = parseCookieHeader(merged);

  assert.equal(cookies.get("wr_vid"), "fresh");
  assert.equal(cookies.get("wr_skey"), "saved");
  assert.equal(cookies.get("theme"), "dark");
});

test("normalizeReaderPath only accepts reader paths", () => {
  assert.equal(
    normalizeReaderPath("/web/reader/abc?chapter=2"),
    "/web/reader/abc?chapter=2"
  );
  assert.equal(normalizeReaderPath("/web/shelf"), undefined);
  assert.equal(
    normalizeReaderPath("/web/reader/abc?q=</script>"),
    "/web/reader/abc?q=%3C/script%3E"
  );
});

test("SessionVault persists login cookies without exposing their values", async () => {
  const storage = new Map<string, string>();
  const secrets = {
    get: async (key: string) => storage.get(key),
    store: async (key: string, value: string) => {
      storage.set(key, value);
    },
    delete: async (key: string) => {
      storage.delete(key);
    },
    keys: async () => [...storage.keys()],
    onDidChange: (() => ({ dispose() {} })) as vscode.Event<vscode.SecretStorageChangeEvent>
  } satisfies vscode.SecretStorage;

  const first = new SessionVault(secrets);
  await first.load();
  first.captureSetCookies([
    "wr_vid=123; Path=/",
    "wr_skey=encrypted-value; Path=/"
  ]);
  await first.flush();

  const restored = new SessionVault(secrets);
  await restored.load();
  assert.equal(restored.isLoggedIn, true);
  assert.match(restored.cookieHeader ?? "", /wr_vid=123/);
  assert.match(restored.cookieHeader ?? "", /wr_skey=encrypted-value/);
});
