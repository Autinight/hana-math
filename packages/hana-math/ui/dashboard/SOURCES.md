# Danus dashboard port

Upstream: Danus `6d92e8d415933ca2ef52fd1a4da73fdfcd418f1c:danus/observability/static/` (Apache-2.0; see `LICENSE`). Original SHA-256: `index.html` `6c734f9e2905d51d8a9a4250766bcd87f25a3ec864b31d2483d06ee70e92d943`, `app.js` `892169bb4c943f3b4ad3c11ff940adf194afb4614fcc3307f14f29dfb2433efb`, `style.css` `d93939e614fd7cab94945f0cd47078b94baf61e9b0c093022071a5256b98b686`. Changes: relative assets, host theme colors, and a trusted embedding request callback (not bound by default). Original tabs, canvas graph, markdown/math, channel UI, and 15-second Overview interval when bound remain. No project identity or endpoint comes from the URL or a message.

Distribution files are unmodified from the official npm registry packages below. The verified cache inputs and individual asset hashes are recorded in `dist/validation/m03-dashboard-upstream-001/api-and-assets.json`. All 60 KaTeX font files, original vendor CSS, licenses, and the ECharts NOTICE are included.

| Package | Version | License | Registry integrity |
|---|---|---|---|
| ECharts | 5.5.0 | Apache-2.0 | `sha512-rNYnNCzqDAPCr4m/fqyUFv7fD9qIsd50S6GDFgO1DxZhncCsNsG7IfUlAlvZe5oSEQxtsjnHiUuppzccry93Xw==` |
| KaTeX | 0.16.11 | MIT | `sha512-RQrI8rlHY92OLf3rho/Ts8i/XvjgguEjOkO1BEXcU3N8BqPpSzBNwV/G0Ukr+P/l3ivvJUE/Fa/CwbS6HesGNQ==` |
| markdown-it | 14.1.0 | MIT | `sha512-a54IwgWPaeBCAAsv13YgmALOF1elABB08FxO9i+r4VFk5Vl4pKokRPeX8u5TCgSsPi6ec1otfLjdOpVcgbpshg==` |

Hana Preview opens `.hanamathgraph` attachments in this page as read-only Fact Graph snapshots. The page only reads the document bound by Hana; the sampling time is shown in UTC. This snapshot has no Overview or Global Memory data and does not refresh. No backend route, sample replay, theme write, or new permission is included.
