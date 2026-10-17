# Card profit

A small offline-capable PWA that tells you the profit and margin on each gift card you resell
(buy balance with USDT -> pay for the card in EUR -> sell it for TND).
Plain HTML/CSS/JS, no framework, **no build step**.

```
public/            <- the site (this is what Netlify publishes)
  index.html  style.css  app.js  sw.js  manifest.json  icons/*.png
tests/             <- Playwright end-to-end tests (not deployed)
scripts/make_icons.py   <- regenerates the PNG icons (Pillow)
netlify.toml       <- publish dir + no-stale-cache headers
```

## Deploy on Netlify

- **Git:** connect the repo. `netlify.toml` already sets `publish = "public"` and there is no build command.
- **Drag & drop:** drag the `public` folder onto <https://app.netlify.com/drop>.

Then open the site on your phone and use *Share -> Add to Home Screen* (iOS) or *Install app* (Android/Chrome).

## Updating without stale caches

The header shows a version label (`v1.0`). The service worker is **network-first** (the cache is only the
offline fallback), and `netlify.toml` sends `max-age=0, must-revalidate` for every file and `no-store` for
`sw.js`, so a normal deploy shows up on the next open. If you want to be certain old caches are purged:

1. bump `APP_VERSION` in `public/app.js` **and** `VERSION` in `public/sw.js` (the tests fail if they differ),
2. deploy. The new worker deletes every cache that is not `card-profit-v<VERSION>`.

If a phone still looks old, the version label tells you which build it loaded.

## Math

```
usdPer100Credit = creditPrice                (USD)   |  creditPrice * eurUsdRate  (EUR)
costUSDT   = displayedPrice * usdPer100Credit / 100
costTND    = costUSDT * usdtPrice
profitTND  = sellPrice - costTND
marginOnCost = profit / costTND * 100        marginOnSale = profit / sellPrice * 100
profitUSDT = profitTND / usdtPrice           breakEven = costTND
suggested  = costTND * 1.10 / 1.15 / 1.20
```

Both `.` and `,` are accepted as the decimal separator (also `1 234,5`, `1,234.56`, Arabic-Indic digits).

The EUR/USD rate is fetched on load and with **Pull live** (frankfurter.dev, falling back to open.er-api.com).
A rate you typed by hand is never overwritten by the automatic on-load fetch; only the button replaces it.

## Tests

```
npm install
npm test            # starts a local server, drives headless Chromium at 390px and 1280px
```

Set `CHROMIUM=/path/to/chrome` if Playwright's browser is not installed. The run also writes screenshots to
`tests/screenshots/` (git-ignored). The live-rate APIs are mocked in the tests.
