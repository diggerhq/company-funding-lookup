import assert from "node:assert/strict";
import { test } from "node:test";
import { isBlockedIp, normalizeInputUrl, safeGet, UnsafeUrlError } from "../opencomputer/agents/funding/lib/url-safety";
import { FakeWeb } from "./fixtures/world";

test("normalizes bare domains to https and strips fragments", () => {
  assert.equal(normalizeInputUrl("acme-robotics.example/about#team").toString(), "https://acme-robotics.example/about");
  assert.equal(normalizeInputUrl("  HTTP://Acme-Robotics.example  ").toString(), "http://acme-robotics.example/");
});

test("rejects non-web schemes, credentials, odd ports and local hosts", () => {
  for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "ftp://acme.example/", "gopher://acme.example", "data:text/html,hi", "https://user:pw@acme.example/", "https://acme.example:8443/", "http://localhost/", "http://foo.localhost/", "http://metadata.google.internal/", "http://intranet/", "https://printer.local/"]) {
    assert.throws(() => normalizeInputUrl(bad), UnsafeUrlError, bad);
  }
});

test("blocks private, loopback, link-local, metadata, CGNAT and mapped addresses", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fe80::1", "fd00:ec2::254", "fc00::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "64:ff9b::a9fe:a9fe", "2002:a9fe:a9fe::1", "::ffff:7f00:1"]) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
  for (const ip of ["93.184.216.34", "8.8.8.8", "2606:4700::6810:84e5"]) assert.equal(isBlockedIp(ip), false, ip);
  assert.throws(() => normalizeInputUrl("http://169.254.169.254/latest/meta-data/"), UnsafeUrlError);
  assert.throws(() => normalizeInputUrl("http://[::ffff:127.0.0.1]/"), UnsafeUrlError);
  assert.throws(() => normalizeInputUrl("http://2130706433/"), UnsafeUrlError); // decimal 127.0.0.1 is parsed by URL into 127.0.0.1
});

test("refuses hosts whose DNS resolves to a private address", async () => {
  const web = new FakeWeb().page("https://rebind.example/", "<html></html>");
  web.dns.set("rebind.example", ["93.184.216.34", "10.0.0.5"]);
  await assert.rejects(safeGet("https://rebind.example/", { hop: web.hop, resolve: web.resolve }), (e: any) => e.code === "private_address");
  assert.equal(web.hops.length, 0, "no request was sent");
});

test("follows bounded safe redirects and keeps the chain", async () => {
  const web = new FakeWeb().redirect("https://acme.example/", "https://www.acme.example/").redirect("https://www.acme.example/", "/home").page("https://www.acme.example/home", "<html>ok</html>");
  const r = await safeGet("acme.example", { hop: web.hop, resolve: web.resolve });
  assert.equal(r.finalUrl, "https://www.acme.example/home");
  assert.deepEqual(r.chain, ["https://acme.example/", "https://www.acme.example/", "https://www.acme.example/home"]);
});

test("blocks redirects to metadata, private hosts, other schemes, and loops", async () => {
  const web = new FakeWeb()
    .redirect("https://a.example/", "http://169.254.169.254/latest/meta-data/")
    .redirect("https://b.example/", "file:///etc/passwd")
    .redirect("https://c.example/", "https://internal.example/");
  web.dns.set("internal.example", ["192.168.0.10"]);
  await assert.rejects(safeGet("https://a.example/", { hop: web.hop, resolve: web.resolve }), (e: any) => e.code === "redirect_unsafe");
  await assert.rejects(safeGet("https://b.example/", { hop: web.hop, resolve: web.resolve }), (e: any) => e.code === "redirect_unsafe");
  await assert.rejects(safeGet("https://c.example/", { hop: web.hop, resolve: web.resolve }), (e: any) => e.code === "private_address");
  const loop = new FakeWeb().redirect("https://l.example/1", "https://l.example/2").redirect("https://l.example/2", "https://l.example/1");
  await assert.rejects(safeGet("https://l.example/1", { hop: loop.hop, resolve: loop.resolve }), (e: any) => e.code === "redirects");
});
