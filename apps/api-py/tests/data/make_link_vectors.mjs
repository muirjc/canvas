// Regenerates link_vectors.json: for each href, `new URL(href, base).protocol` (without the colon) or null
// when the URL parser throws -- the check behind isAllowedLinkHref (diagram-core, jmuir-dzd.5).
//   node apps/api-py/tests/data/make_link_vectors.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = 'https://relative-path-base.invalid/';
const hrefs = [
  '', ' ', 'x', 'x.html', './x', '../x', '/x', '/', '?q=1', '#frag', 'a/b/c?d#e', 'a:b', 'a.b:c', '1a:b', '+a:b', 'a+b-c.d:e',
  'https://example.com', 'https://example.com/a/b?c=d#e', 'HTTPS://EXAMPLE.COM', 'http://example.com', 'HtTp://example.com', 'ftp://example.com/x', 'ws://example.com', 'wss://example.com',
  'file:///etc/passwd', 'file://host/x', 'file:x',
  'javascript:alert(1)', 'JavaScript:alert(1)', 'JaVaScRiPt:alert(1)', 'JAVASCRIPT:alert(1)', ' javascript:alert(1)', '\tjavascript:alert(1)', '\njavascript:alert(1)',
  '\x01javascript:alert(1)', '\x1fjavascript:alert(1)', '\x00javascript:alert(1)', 'javascript:alert(1)\x01', 'javascript:alert(1) ', 'java\tscript:alert(1)', 'java\nscript:alert(1)', 'java\rscript:alert(1)',
  'jav&#x09;ascript:alert(1)', '&#106;avascript:alert(1)', 'javascript&colon;alert(1)', 'javascript%3Aalert(1)', '\u00a0javascript:alert(1)', '\u2028javascript:alert(1)', 'javascript\u0000:alert(1)',
  'data:text/html,<script>alert(1)</script>', 'DATA:text/html,x', 'data:,x', 'vbscript:msgbox(1)', 'VbScript:x', 'blob:https://example.com/uuid', 'about:blank', 'chrome://settings', 'tel:+123', 'sms:+123',
  'mailto:a@b.c', 'MAILTO:a@b.c', 'mailto:', 'mailto:a@b.c?subject=x',
  'http:foo', 'https:foo', 'http:/foo', 'https:/foo', 'http:\\\\example.com', 'https:\\\\example.com', 'https:\\example.com', 'http:///example.com', 'https:///example.com', 'http:////example.com', 'http://', 'https://', 'http:', 'https:', 'http:/', 'https:/', 'HTTPS:foo',
  '//host', '//host/path', '//', '///', '//host:80', '//host:99999', '//user@host', '\\\\host', '\\\\host\\path', '/\\host', '//[::1]', '//exa mple.com',
  'http://exa mple.com', 'http://exa\tmple.com', 'http://exa\nmple.com', 'http://example.com/a b', 'http://example .com', 'http://example.com :80', 'http://[::1]', 'http://[::1]:8080/x', 'http://[::1', 'http://[::1]x', 'http://[::g]', 'http://[1:2:3:4:5:6:7:8]/', 'http://[1:2:3:4:5:6:7:8:9]/', 'http://[::ffff:1.2.3.4]/', 'http://[]/',
  'http://example.com:80', 'http://example.com:8080/x', 'http://example.com:65535', 'http://example.com:65536', 'http://example.com:99999', 'http://example.com:abc', 'http://example.com:', 'http://example.com:-1', 'http://example.com:08', 'http://:80', 'http://:80/x',
  'http://user@example.com', 'http://user:pass@example.com', 'http://user:pass@example.com:80/x', 'http://@example.com', 'http://user@', 'http://user:pass@', 'http://a@b@example.com', 'http://us er@example.com',
  'http://example.com\\path', 'http://example.com?q', 'http://example.com#f', 'http://?q', 'http://#f', 'http:///', 'http://example.com/%zz', 'http://exa%mple.com', 'http://exa%2Fmple.com', 'http://%41.com', 'http://%00.com', 'http://%.com',
  'http://exa<mple.com', 'http://exa>mple.com', 'http://exa^mple.com', 'http://exa|mple.com', 'http://exa[mple.com', 'http://exa]mple.com', 'http://exa\\mple.com', 'http://exa@mple.com', 'http://exa$mple.com', 'http://exa_mple.com', 'http://exa!mple.com', 'http://exa\u00e9mple.com', 'http://\u65e5\u672c.jp', 'http://\ud83c\udfa8.com',
  'http://1.2.3.4', 'http://1.2.3', 'http://0x7f.1', 'http://256.1.1.1', 'http://1.2.3.4.5', 'http://999999999999', 'http://localhost', 'http://LOCALHOST:3000',
  'http://example.com/\x00', 'http://example.com/\u00e9', 'https://example.com/\u00e9?\u00e9#\u00e9',
  ' https://example.com', 'https://example.com ', '\thttps://example.com\n', '\x01https://example.com', '\x0chttps://example.com', '\u00a0https://example.com', '\ufeffhttps://example.com',
  'https://example.com/a\tb', 'https://exa\tmple.com', 'ht\ntps://example.com', 'https\t://example.com', 'https ://example.com', 'https:\t//example.com', 'https:/\t/example.com',
  'x:y:z', 'a b:c', ':x', '://x', 'http//x', 'http:://x', 'tel:123', 'urn:isbn:0451450523', 'git+ssh://git@host/x', 'ssh://host', 'custom-scheme://x', 'x-y.z+w:1',
];
// Hosts in the usual positions: IPv4 spellings, IPv6, percent escapes, forbidden characters, trailing dots.
const hosts = ['1.2.3.4', '1.2.3.4.', '0x7f.0.0.1', '0X7F.1', '017.1', '08.1', '1.2.3.256', '1.2.256', '1.65536', '16777215', '16777216', '4294967295', '4294967296', '1.2.3.4a', 'a.1', 'a.1.', '1.a', '0x', '0x.1', '.', '..', 'a..b', 'a.b.', '.a', 'a-b', '-a', 'a_b', 'EXAMPLE.com', 'a%41', 'a%4', 'a%zz', 'a%25', 'a%20b', 'a%00', 'a%7f', '[::1]', '[::]', '[1::]', '[1:2:3:4:5:6:7::]', '[::1.2.3.4]', '[::1%25eth0]', '[fe80::1%eth0]', '[::ffff:999.1.1.1]', '[:::]', 'a b', 'a\x7fb', 'a\u0080b', 'xn--nxasmq6b', '\u00df.de', '\uff21.com'];
for (const h of hosts) for (const form of ['http://H', 'https://H/p', 'http://H:80/', 'http://u@H', '//H/x']) hrefs.push(form.replace('H', h));
const vectors = hrefs.map((href) => {
  let protocol = null;
  try {
    protocol = new URL(href, BASE).protocol.replace(/:$/, '');
  } catch {
    /* throws -> null */
  }
  return { href, protocol };
});
const out = fileURLToPath(new URL('./link_vectors.json', import.meta.url));
writeFileSync(out, JSON.stringify(vectors, null, 0).replace(/\},\{/g, '},\n{') + '\n');
console.log(`${vectors.length} vectors -> ${out}`);
