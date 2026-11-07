import assert from "node:assert/strict";
import test from "node:test";
import { docsCopy, docsLocale, localizedEntryId, localizedPath } from "../src/lib/locale.ts";

test("Chinese is the default and English is selected by its route segment", () => {
  assert.equal(docsLocale("/"), "zh");
  assert.equal(docsLocale("/zh/quickstart/"), "zh");
  assert.equal(docsLocale("/en/quickstart/"), "en");
  assert.equal(docsLocale("/english/"), "zh");
  assert.equal(docsCopy("zh").htmlLang, "zh-CN");
  assert.equal(docsCopy("en").htmlLang, "en");
});

test("changing language retains the document and canonical trailing slash", () => {
  assert.equal(localizedPath("/zh/quickstart/", "en"), "/en/quickstart/");
  assert.equal(localizedPath("/en/guides/files", "zh"), "/zh/guides/files/");
  assert.equal(localizedPath("/zh/", "en"), "/en/");
  assert.equal(localizedPath("/en/", "zh"), "/zh/");
});

test("unknown pages lead to the destination overview rather than a fabricated translation", () => {
  assert.equal(localizedPath("/", "en"), "/en/");
  assert.equal(localizedPath("/missing-page/", "zh"), "/zh/");
});

test("content identifiers retain their index convention and do not fabricate non-doc counterparts", () => {
  assert.equal(localizedEntryId("zh/index", "en"), "en/index");
  assert.equal(localizedEntryId("en", "zh"), "zh");
  assert.equal(localizedEntryId("zh/quickstart", "en"), "en/quickstart");
  assert.equal(localizedEntryId(undefined, "en"), undefined);
  assert.equal(localizedEntryId("404", "en"), undefined);
});
