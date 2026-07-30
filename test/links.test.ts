import assert from "node:assert/strict";
import test from "node:test";
import { OFFICIAL_URLS, officialUriForAction } from "../src/links";

test("official links use the WeRead HTTPS origin", () => {
  for (const url of Object.values(OFFICIAL_URLS)) {
    const parsed = new URL(url);
    assert.equal(parsed.protocol, "https:");
    assert.equal(parsed.hostname, "weread.qq.com");
  }
});

test("launcher only accepts allowlisted actions", () => {
  assert.equal(officialUriForAction("home"), OFFICIAL_URLS.home);
  assert.equal(officialUriForAction("shelf"), OFFICIAL_URLS.shelf);
  assert.equal(officialUriForAction("https://example.com"), undefined);
  assert.equal(officialUriForAction(undefined), undefined);
});
