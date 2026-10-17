/* Card profit - all behaviour lives in this one file.
 * No inline handlers: every listener is attached with addEventListener in init(). */
(function () {
  "use strict";

  var APP_VERSION = "1.0";
  var STORAGE_KEY = "cardProfit.settings.v1";
  var DESKTOP_QUERY = "(min-width: 900px)";
  var SUGGESTED_MARGINS = [10, 15, 20];

  var DEFAULTS = {
    usdtPrice: "3.38",
    creditPrice: "113",
    currency: "USD",
    eurUsdRate: "1.08",
    rateAt: "",          // ISO time of the last successful live pull
    rateSource: "",
    rateManual: false,   // true once the user typed their own rate
    desktopSettingsHidden: false
  };

  var RATE_SOURCES = [
    {
      name: "frankfurter.dev",
      url: "https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD"
    },
    {
      name: "open.er-api.com",
      url: "https://open.er-api.com/v6/latest/EUR"
    }
  ];

  /* ------------------------------------------------------------------ *
   * Pure logic (also exposed as window.CardProfit for the tests)
   * ------------------------------------------------------------------ */

  // Accepts "18.84", "18,84", "1 234,5", "1,234.56", Arabic-Indic digits and ".
  // Returns {state: "empty"} | {state: "invalid"} | {state: "ok", value: n}
  function parseNumber(raw) {
    if (raw === null || raw === undefined) return { state: "empty" };
    var s = String(raw)
      .replace(/[\u0660-\u0669]/g, function (d) { return String(d.charCodeAt(0) - 0x0660); })
      .replace(/[\u06f0-\u06f9]/g, function (d) { return String(d.charCodeAt(0) - 0x06F0); })
      .replace(/\u066b/g, ".")                 // Arabic decimal separator
      .replace(/[\u066c\s\u00a0\u202f]/g, ""); // Arabic thousands separator + any spaces
    if (s === "") return { state: "empty" };

    var lastDot = s.lastIndexOf(".");
    var lastComma = s.lastIndexOf(",");
    if (lastDot !== -1 && lastComma !== -1) {
      // both present: the one that comes last is the decimal mark, the other groups thousands
      if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
      else s = s.replace(/,/g, "");
    } else {
      s = s.replace(/,/g, ".");
    }
    if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return { state: "invalid" };
    var n = parseFloat(s);
    if (!isFinite(n)) return { state: "invalid" };
    return { state: "ok", value: n };
  }

  function usdPerEur(creditPrice, currency, eurUsdRate) {
    var usdPer100Credit = currency === "EUR" ? creditPrice * eurUsdRate : creditPrice;
    return usdPer100Credit / 100;
  }

  // i: {displayedPrice, sellPrice, usdtPrice, creditPrice, currency, eurUsdRate} (numbers)
  function compute(i) {
    var perEur = usdPerEur(i.creditPrice, i.currency, i.eurUsdRate);
    var costUSDT = i.displayedPrice * perEur;
    var costTND = costUSDT * i.usdtPrice;
    var profitTND = i.sellPrice - costTND;
    return {
      usdPer100Credit: perEur * 100,
      usdPerEur: perEur,
      costUSDT: costUSDT,
      costTND: costTND,
      profitTND: profitTND,
      marginOnCost: profitTND / costTND * 100,
      marginOnSale: profitTND / i.sellPrice * 100,
      profitUSDT: profitTND / i.usdtPrice,
      breakEven: costTND,
      suggested: SUGGESTED_MARGINS.map(function (m) {
        var price = costTND * (1 + m / 100);
        return { margin: m, price: price, profit: price - costTND };
      })
    };
  }

  function fmt(n, digits) {
    if (!isFinite(n)) return "-";
    var s = n.toFixed(digits === undefined ? 2 : digits);
    if (/^-0(\.0+)?$/.test(s)) s = s.slice(1);   // never show "-0.00"
    return s;
  }
  function sign(n, digits) {          // -1 / 0 / 1 of the number *as displayed*
    return Math.sign(parseFloat(fmt(n, digits)));
  }
  function fmtSigned(n, digits) {
    var s = fmt(n, digits);
    return sign(n, digits) > 0 ? "+" + s : s;
  }
  function trim(n, digits) {          // 3.3800 -> "3.38"
    var s = n.toFixed(digits);
    return s.indexOf(".") === -1 ? s : s.replace(/0+$/, "").replace(/\.$/, "");
  }

  /* ------------------------------------------------------------------ *
   * Storage (always wrapped: it can throw or be blocked)
   * ------------------------------------------------------------------ */

  function loadSettings() {
    var out = {};
    var k;
    for (k in DEFAULTS) if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) out[k] = DEFAULTS[k];
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var saved = JSON.parse(raw);
        if (saved && typeof saved === "object") {
          for (k in DEFAULTS) {
            if (Object.prototype.hasOwnProperty.call(saved, k) && typeof saved[k] === typeof DEFAULTS[k]) {
              out[k] = saved[k];
            }
          }
        }
      }
    } catch (e) { /* storage unavailable or corrupt: fall back to defaults */ }
    if (out.currency !== "USD" && out.currency !== "EUR") out.currency = "USD";
    return out;
  }

  function saveSettings(settings) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ------------------------------------------------------------------ *
   * Live rate
   * ------------------------------------------------------------------ */

  function fetchJson(url, timeoutMs) {
    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs) : null;
    return fetch(url, { cache: "no-store", signal: ctrl ? ctrl.signal : undefined })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) { if (timer) clearTimeout(timer); return data; },
            function (err) { if (timer) clearTimeout(timer); throw err; });
  }

  // Tries each source in order. Resolves {rate, source}; rejects with an array of reasons.
  function pullLiveRate() {
    var reasons = [];
    function attempt(idx) {
      if (idx >= RATE_SOURCES.length) return Promise.reject(reasons);
      var src = RATE_SOURCES[idx];
      return fetchJson(src.url, 8000).then(function (data) {
        var v = Number(data && data.rates && data.rates.USD);
        if (!(v > 0) || !isFinite(v)) throw new Error("unexpected response");
        return { rate: v, source: src.name };
      }).catch(function (err) {
        reasons.push(src.name + ": " + (err && err.name === "AbortError" ? "timed out" : (err && err.message) || "failed"));
        return attempt(idx + 1);
      });
    }
    return attempt(0);
  }

  /* ------------------------------------------------------------------ *
   * UI
   * ------------------------------------------------------------------ */

  function init() {
    var $ = function (id) { return document.getElementById(id); };
    var el = {
      app: $("app"),
      settingsBtn: $("settings-btn"),
      version: $("version"),
      form: $("calc-form"),
      displayed: $("displayedPrice"),
      sell: $("sellPrice"),
      calcBtn: $("calc-btn"),
      msg: $("result-msg"),
      msgTitle: $("result-msg-title"),
      msgList: $("result-msg-list"),
      msgSettingsBtn: $("msg-settings-btn"),
      ok: $("result-ok"),
      profit: $("out-profit"),
      marginCost: $("out-margin-cost"),
      marginSale: $("out-margin-sale"),
      chain: $("out-chain"),
      costTnd: $("out-cost-tnd"),
      costUsdt: $("out-cost-usdt"),
      profitUsdt: $("out-profit-usdt"),
      breakEven: $("out-breakeven"),
      suggest: $("out-suggest"),
      ratesLine: $("rates-line"),
      usdt: $("usdtPrice"),
      credit: $("creditPrice"),
      currencyRadios: document.querySelectorAll('input[name="currency"]'),
      rateGroup: $("rate-group"),
      rate: $("eurUsdRate"),
      rateBtn: $("rate-btn"),
      rateHint: $("rate-hint"),
      rateStatus: $("rate-status"),
      rateError: $("rate-error"),
      summary: $("settings-summary")
    };

    var settings = loadSettings();
    var touched = false;      // the user pressed Calculate / Enter at least once
    var pulling = false;
    var desktopMq = window.matchMedia(DESKTOP_QUERY);

    el.version.textContent = "v" + APP_VERSION;

    /* ---- reading + validating inputs ---- */

    function labelled(text, parsed, raw) {
      // returns {value} or {problem, kind} for one numeric field
      if (parsed.state === "empty") return { problem: text + " is missing", kind: "missing" };
      if (parsed.state === "invalid") return { problem: text + ": \u201c" + String(raw).trim() + "\u201d is not a number", kind: "invalid" };
      if (!(parsed.value > 0)) return { problem: text + " must be greater than 0", kind: "invalid" };
      return { value: parsed.value };
    }

    function readAll() {
      var out = { calc: [], settings: [], values: {}, fields: {} };

      function take(group, key, text, raw, field) {
        var p = labelled(text, parseNumber(raw), raw);
        out.fields[key] = p;
        if (p.problem) group.push({ text: p.problem, kind: p.kind, field: field, key: key });
        else out.values[key] = p.value;
      }

      take(out.calc, "displayedPrice", "Card price (EUR)", el.displayed.value, el.displayed);
      take(out.calc, "sellPrice", "Sell price (TND)", el.sell.value, el.sell);
      take(out.settings, "usdtPrice", "USDT price (Settings)", settings.usdtPrice, el.usdt);
      take(out.settings, "creditPrice", "Credit price (Settings)", settings.creditPrice, el.credit);
      out.values.currency = settings.currency;
      if (settings.currency === "EUR") {
        take(out.settings, "eurUsdRate", "EUR/USD rate (Settings)", settings.eurUsdRate, el.rate);
      } else {
        var rp = parseNumber(settings.eurUsdRate);
        out.values.eurUsdRate = rp.state === "ok" && rp.value > 0 ? rp.value : 1;   // unused for USD
      }
      return out;
    }

    /* ---- rendering ---- */

    function setText(node, text) { node.textContent = text; }

    function markInvalid(field, bad) {
      if (bad) field.setAttribute("aria-invalid", "true");
      else field.removeAttribute("aria-invalid");
    }

    function renderMessage(state) {
      var all = state.calc.concat(state.settings);
      var anyInvalid = all.some(function (p) { return p.kind === "invalid"; });
      var bothCalcEmpty = state.calc.length === 2 && state.calc.every(function (p) { return p.kind === "missing"; });

      el.msgList.textContent = "";
      if (bothCalcEmpty && !touched && state.settings.length === 0) {
        setText(el.msgTitle, "Enter the card price and your sell price to see your profit.");
        el.msg.classList.remove("is-error");
        el.msgSettingsBtn.hidden = true;
        return;
      }
      setText(el.msgTitle, anyInvalid ? "Check these values:" : "Can\u2019t calculate yet:");
      all.forEach(function (p) {
        var li = document.createElement("li");
        li.textContent = p.text;
        el.msgList.appendChild(li);
      });
      el.msg.classList.toggle("is-error", anyInvalid);
      el.msgSettingsBtn.hidden = state.settings.length === 0;
    }

    function renderResult(v, r) {
      var profitDigits = 2;
      setText(el.profit, fmtSigned(r.profitTND, profitDigits) + " TND");
      el.profit.setAttribute("data-sign", String(sign(r.profitTND, profitDigits)));
      setText(el.marginCost, fmt(r.marginOnCost, 1) + "%");
      setText(el.marginSale, fmt(r.marginOnSale, 1) + "%");
      // each step is its own nowrap span so a narrow screen breaks at the arrows, never inside "71.96 TND"
      el.chain.textContent = "";
      [fmt(v.displayedPrice) + " EUR", fmt(r.costUSDT) + " USDT", fmt(r.costTND) + " TND"].forEach(function (step, idx) {
        if (idx) el.chain.appendChild(document.createTextNode(" \u2192 "));
        var span = document.createElement("span");
        span.className = "step";
        span.textContent = step;
        el.chain.appendChild(span);
      });
      setText(el.costTnd, fmt(r.costTND) + " TND");
      setText(el.costUsdt, fmt(r.costUSDT) + " USDT");
      setText(el.profitUsdt, fmtSigned(r.profitUSDT) + " USDT");
      setText(el.breakEven, fmt(r.breakEven) + " TND");

      el.suggest.textContent = "";
      r.suggested.forEach(function (s) {
        var li = document.createElement("li");
        var pct = document.createElement("span");
        pct.className = "pct";
        pct.textContent = s.margin + "%";
        var right = document.createElement("span");
        var price = document.createElement("span");
        price.className = "price";
        price.textContent = fmt(s.price) + " TND";
        var gain = document.createElement("span");
        gain.className = "gain";
        gain.textContent = "+" + fmt(s.profit);
        right.appendChild(price);
        right.appendChild(gain);
        li.appendChild(pct);
        li.appendChild(right);
        el.suggest.appendChild(li);
      });
    }

    function renderRatesLine(state) {
      el.ratesLine.textContent = "";
      el.summary.textContent = "";
      if (state.settings.length) return;
      var v = state.values;
      var perEur = usdPerEur(v.creditPrice, v.currency, v.eurUsdRate);
      var credit = v.currency === "EUR"
        ? trim(v.creditPrice, 4) + " EUR (= " + trim(v.creditPrice * v.eurUsdRate, 4) + " USD at " + trim(v.eurUsdRate, 4) + ")"
        : trim(v.creditPrice, 4) + " USD";
      el.ratesLine.appendChild(document.createTextNode(
        "1 USDT = " + trim(v.usdtPrice, 4) + " TND \u00b7 100 EUR of credit costs " + credit + " \u00b7 "));
      var edit = document.createElement("button");
      edit.type = "button";
      edit.textContent = "Edit in Settings";
      edit.addEventListener("click", function () { showSettings(true); });
      el.ratesLine.appendChild(edit);

      setText(el.summary, "1 EUR of platform balance = " + fmt(perEur, 4) + " USDT = " + fmt(perEur * v.usdtPrice) + " TND.");
    }

    function update(explicit) {
      if (explicit) touched = true;
      var state = readAll();

      // highlight bad fields (empty fields only once the user asked for a result)
      ["displayedPrice", "sellPrice"].forEach(function (k) {
        var f = state.fields[k];
        markInvalid(k === "displayedPrice" ? el.displayed : el.sell, !!f.problem && (f.kind === "invalid" || touched));
      });
      [["usdtPrice", el.usdt], ["creditPrice", el.credit], ["eurUsdRate", el.rate]].forEach(function (pair) {
        var f = state.fields[pair[0]];
        markInvalid(pair[1], !!(f && f.problem));
      });

      var problems = state.calc.length + state.settings.length;
      if (problems) {
        el.ok.hidden = true;
        el.msg.hidden = false;
        renderMessage(state);
      } else {
        el.msg.hidden = true;
        el.ok.hidden = false;
        var inputs = {
          displayedPrice: state.values.displayedPrice,
          sellPrice: state.values.sellPrice,
          usdtPrice: state.values.usdtPrice,
          creditPrice: state.values.creditPrice,
          currency: state.values.currency,
          eurUsdRate: state.values.eurUsdRate
        };
        renderResult(inputs, compute(inputs));
      }
      renderRatesLine(state);
      return state;
    }

    /* ---- settings panel ---- */

    function formatPulled(iso) {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return "";
      try {
        return d.toLocaleString([], { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
      } catch (e) {
        return d.toISOString();
      }
    }

    function renderRateStatus() {
      var when = settings.rateAt ? formatPulled(settings.rateAt) : "";
      var text;
      if (pulling) text = "Pulling live rate\u2026";
      else if (settings.rateManual) text = "Manual value" + (when ? " \u00b7 last live pull " + when : "") + ".";
      else if (when) text = "Live rate pulled " + when + (settings.rateSource ? " (" + settings.rateSource + ")" : "") + ".";
      else text = "Not pulled yet \u2013 this is the default value.";
      setText(el.rateStatus, text);
      el.rateBtn.disabled = pulling;
      setText(el.rateBtn, pulling ? "Pulling\u2026" : "Pull live");
    }

    function renderCurrency() {
      var eur = settings.currency === "EUR";
      el.rateGroup.classList.toggle("is-unused", !eur);
      setText(el.rateHint, eur
        ? "Used to turn your EUR credit price into USD."
        : "Not used while the credit price is in USD.");
    }

    function fillSettingsInputs() {
      el.usdt.value = settings.usdtPrice;
      el.credit.value = settings.creditPrice;
      el.rate.value = settings.eurUsdRate;
      Array.prototype.forEach.call(el.currencyRadios, function (r) { r.checked = r.value === settings.currency; });
      renderCurrency();
      renderRateStatus();
    }

    function doPull() {
      if (pulling) return Promise.resolve();
      pulling = true;
      el.rateError.hidden = true;
      renderRateStatus();
      return pullLiveRate().then(function (res) {
        settings.eurUsdRate = res.rate.toFixed(4);
        settings.rateAt = new Date().toISOString();
        settings.rateSource = res.source;
        settings.rateManual = false;
        el.rate.value = settings.eurUsdRate;
        saveSettings(settings);
      }, function (reasons) {
        setText(el.rateError, "Couldn\u2019t pull the live rate (" + (reasons || []).join("; ") + "). Keeping " + settings.eurUsdRate + ".");
        el.rateError.hidden = false;
      }).then(function () {
        pulling = false;
        renderRateStatus();
        update(false);
      });
    }

    /* ---- navigation between views ---- */

    function updateTopButton() {
      var label, expanded;
      if (desktopMq.matches) {
        expanded = el.app.dataset.desktopSettings !== "hidden";
        label = expanded ? "Hide settings" : "Settings";
      } else {
        expanded = el.app.dataset.view === "settings";
        label = expanded ? "Done" : "Settings";
      }
      setText(el.settingsBtn, label);
      el.settingsBtn.setAttribute("aria-expanded", String(expanded));
    }

    function setDesktopHidden(hidden) {
      el.app.dataset.desktopSettings = hidden ? "hidden" : "shown";
      settings.desktopSettingsHidden = hidden;
      saveSettings(settings);
    }

    function showSettings(focusFirst) {
      if (desktopMq.matches) setDesktopHidden(false);
      else {
        el.app.dataset.view = "settings";
        window.scrollTo(0, 0);
      }
      updateTopButton();
      if (focusFirst) {
        var bad = readAll().settings[0];
        (bad ? bad.field : el.usdt).focus({ preventScroll: true });
      }
    }

    function toggleSettings() {
      if (desktopMq.matches) {
        setDesktopHidden(el.app.dataset.desktopSettings !== "hidden");
      } else {
        el.app.dataset.view = el.app.dataset.view === "settings" ? "calc" : "settings";
        window.scrollTo(0, 0);
      }
      updateTopButton();
    }

    /* ---- wiring ---- */

    el.settingsBtn.addEventListener("click", toggleSettings);
    el.msgSettingsBtn.addEventListener("click", function () { showSettings(true); });
    if (desktopMq.addEventListener) desktopMq.addEventListener("change", updateTopButton);
    else if (desktopMq.addListener) desktopMq.addListener(updateTopButton);

    el.form.addEventListener("submit", function (ev) {     // Calculate button and Enter
      ev.preventDefault();
      var state = update(true);
      if (state.calc.length) {
        state.calc[0].field.focus();
      } else if (document.activeElement && document.activeElement.blur) {
        document.activeElement.blur();                      // close the keyboard to reveal the result
      }
    });
    el.displayed.addEventListener("input", function () { update(false); });
    el.sell.addEventListener("input", function () { update(false); });

    function onSettingInput(key, input) {
      input.addEventListener("input", function () {
        settings[key] = input.value;
        if (key === "eurUsdRate") {
          settings.rateManual = true;
          el.rateError.hidden = true;
          renderRateStatus();
        }
        saveSettings(settings);
        update(false);
      });
      input.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter") { ev.preventDefault(); input.blur(); }
      });
    }
    onSettingInput("usdtPrice", el.usdt);
    onSettingInput("creditPrice", el.credit);
    onSettingInput("eurUsdRate", el.rate);

    Array.prototype.forEach.call(el.currencyRadios, function (r) {
      r.addEventListener("change", function () {
        if (!r.checked) return;
        settings.currency = r.value;
        saveSettings(settings);
        renderCurrency();
        update(false);
      });
    });

    el.rateBtn.addEventListener("click", function () { doPull(); });

    /* ---- start ---- */

    el.app.dataset.desktopSettings = settings.desktopSettingsHidden ? "hidden" : "shown";
    fillSettingsInputs();
    updateTopButton();
    update(false);

    if (!settings.rateManual) doPull();       // refresh the rate on load, but never overwrite a hand-typed one

    window.__cardProfitReady = true;
  }

  window.CardProfit = {
    version: APP_VERSION,
    parseNumber: parseNumber,
    compute: compute,
    storageKey: STORAGE_KEY
  };

  /* ------------------------------------------------------------------ *
   * Service worker (offline support). Failure here must never break the app.
   * ------------------------------------------------------------------ */
  function registerServiceWorker() {
    if (!("serviceWorker" in navigator) || !/^https?:$/.test(location.protocol)) return;
    navigator.serviceWorker.register("sw.js").then(function (reg) {
      reg.update().catch(function () {});
      document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "visible") reg.update().catch(function () {});
      });
    }).catch(function (err) {
      if (window.console) console.warn("Service worker not registered:", err);
    });
  }

  function start() {
    init();
    registerServiceWorker();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
