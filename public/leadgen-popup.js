/*
 * LeadGEN pop-up. Embed on any real estate site:
 *   <script src="https://YOUR-SERVER/leadgen-popup.js"
 *           data-api="https://YOUR-SERVER/api/leads"
 *           data-search-form="#search-form"   (optional: open after this form is submitted)
 *           data-delay="20"                   (optional: open after N seconds on search pages, 0 = off)
 *           data-title="Want help finding a home?"></script>
 * Or open it yourself: window.LeadGen.open({ listing_id: "123" })
 */
(function () {
  var script = document.currentScript;
  var cfg = {
    api: script.getAttribute("data-api") || new URL("/api/leads", script.src).href,
    searchForm: script.getAttribute("data-search-form"),
    delay: parseInt(script.getAttribute("data-delay") || "0", 10),
    title: script.getAttribute("data-title") || "Get matched with sellers",
    subtitle: script.getAttribute("data-subtitle") ||
      "Tell us what you're looking for and we'll connect you with sellers and agents for matching listings.",
  };
  var SEEN_KEY = "leadgen_seen", PENDING_KEY = "leadgen_pending";
  var context = {};

  function seen() { try { return sessionStorage.getItem(SEEN_KEY) === "1"; } catch (e) { return false; } }
  function markSeen() {
    try { sessionStorage.setItem(SEEN_KEY, "1"); sessionStorage.removeItem(PENDING_KEY); } catch (e) {}
  }

  function currentQuery() {
    var p = new URLSearchParams(location.search);
    return p.get("q") || p.get("query") || p.get("search") || p.get("location") || "";
  }

  var css = [
    ":host{all:initial}",
    ".bg{position:fixed;inset:0;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;z-index:2147483647;padding:16px;font:15px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}",
    ".box{background:#fff;color:#0f172a;border-radius:14px;max-width:440px;width:100%;max-height:calc(100vh - 32px);overflow:auto;padding:24px;box-shadow:0 20px 50px rgba(0,0,0,.3);position:relative}",
    "h2{margin:0 0 6px;font-size:21px}p{margin:0 0 16px;color:#475569}",
    "label{display:block;font-size:13px;font-weight:600;margin:10px 0 4px}",
    "input,select,textarea{width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:8px;padding:9px 10px;font:inherit;color:inherit;background:#fff}",
    "input:focus,select:focus,textarea:focus{outline:2px solid #2563eb;border-color:#2563eb}",
    ".row{display:flex;gap:10px}.row>div{flex:1;min-width:0}",
    ".consent{display:flex;gap:8px;align-items:flex-start;font-size:12px;color:#475569;margin-top:12px;font-weight:400}.consent input{width:auto;margin-top:2px}",
    "button.go{margin-top:16px;width:100%;background:#2563eb;color:#fff;border:0;border-radius:8px;padding:11px;font:600 15px system-ui,sans-serif;cursor:pointer}button.go:disabled{opacity:.6}",
    ".x{position:absolute;top:10px;right:12px;background:none;border:0;font-size:24px;line-height:1;color:#64748b;cursor:pointer}",
    ".err{color:#dc2626;font-size:13px;margin-top:10px;min-height:1em}",
    ".hp{position:absolute;left:-9999px}",
    ".done{text-align:center;padding:20px 0}",
  ].join("");

  var html =
    '<div class="bg" part="backdrop"><div class="box" role="dialog" aria-modal="true" aria-labelledby="lg-t">' +
    '<button class="x" aria-label="Close">&times;</button>' +
    '<div class="body"><h2 id="lg-t"></h2><p class="sub"></p>' +
    '<form novalidate>' +
    '<label for="lg-name">Full name *</label><input id="lg-name" name="name" autocomplete="name" required>' +
    '<div class="row"><div><label for="lg-email">Email *</label><input id="lg-email" name="email" type="email" autocomplete="email" required></div>' +
    '<div><label for="lg-phone">Phone</label><input id="lg-phone" name="phone" type="tel" autocomplete="tel"></div></div>' +
    '<div class="row"><div><label for="lg-intent">I want to</label><select id="lg-intent" name="intent"><option value="buy">Buy</option><option value="rent">Rent</option><option value="sell">Sell</option></select></div>' +
    '<div><label for="lg-budget">Budget</label><input id="lg-budget" name="budget" placeholder="e.g. $400k"></div></div>' +
    '<label for="lg-loc">Area or address</label><input id="lg-loc" name="location">' +
    '<label for="lg-msg">Anything else?</label><textarea id="lg-msg" name="message" rows="2"></textarea>' +
    '<input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">' +
    '<label class="consent"><input type="checkbox" name="consent" required> I agree to be contacted about properties by phone or email.</label>' +
    '<div class="err" role="alert"></div>' +
    '<button class="go" type="submit">Connect me</button>' +
    '</form></div></div></div>';

  var host, root;

  function build() {
    host = document.createElement("div");
    host.id = "leadgen-popup";
    root = host.attachShadow({ mode: "open" });
    root.innerHTML = "<style>" + css + "</style>" + html;
    root.querySelector("h2").textContent = cfg.title;
    root.querySelector(".sub").textContent = cfg.subtitle;
    root.querySelector(".x").onclick = close;
    root.querySelector(".bg").addEventListener("click", function (e) { if (e.target.classList.contains("bg")) close(); });
    root.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
    root.querySelector("form").addEventListener("submit", submit);
  }

  function open(extra) {
    context = extra || {};
    if (!host) build();
    var form = root.querySelector("form");
    if (form && context.location) form.location.value = context.location;
    else if (form && !form.location.value) form.location.value = context.search_query || currentQuery();
    if (form && context.intent) form.intent.value = context.intent;
    document.body.appendChild(host);
    markSeen();
    var first = root.querySelector("input");
    if (first) first.focus();
  }

  function close() {
    if (host && host.parentNode) host.parentNode.removeChild(host);
    if (root && root.querySelector(".done")) host = null; // fresh form next time
  }

  function submit(e) {
    e.preventDefault();
    var f = e.target, err = root.querySelector(".err"), btn = root.querySelector(".go");
    err.textContent = "";
    if (!f.name.value.trim()) return (err.textContent = "Please enter your name.");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email.value.trim())) return (err.textContent = "Please enter a valid email.");
    if (!f.consent.checked) return (err.textContent = "Please agree to be contacted.");
    var lead = {
      name: f.name.value, email: f.email.value, phone: f.phone.value, intent: f.intent.value,
      budget: f.budget.value, location: f.location.value, message: f.message.value,
      website: f.website.value, consent: true,
      search_query: context.search_query || currentQuery(),
      listing_id: context.listing_id || "", page_url: location.href,
    };
    btn.disabled = true; btn.textContent = "Sending…";
    fetch(cfg.api, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(lead) })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function () {
        root.querySelector(".body").innerHTML =
          '<div class="done"><h2>Thanks!</h2><p>We\'ll be in touch shortly with matching listings and sellers.</p></div>';
        document.dispatchEvent(new CustomEvent("leadgen:submitted", { detail: lead }));
      })
      .catch(function () {
        err.textContent = "Something went wrong. Please try again.";
        btn.disabled = false; btn.textContent = "Connect me";
      });
  }

  // Triggers
  if (cfg.searchForm) {
    document.addEventListener("submit", function (e) {
      if (e.target.matches && e.target.matches(cfg.searchForm) && !seen()) {
        var q = e.target.querySelector("input[type=search],input[name=q],input");
        var query = q ? q.value : "";
        // If the search reloads the page, the pending flag opens the pop-up on the results page.
        try { sessionStorage.setItem(PENDING_KEY, query); } catch (err) {}
        setTimeout(function () { if (!seen()) open({ search_query: query }); }, 600);
      }
    }, true);
  }
  var pending = null;
  try { pending = sessionStorage.getItem(PENDING_KEY); } catch (e) {}
  if (pending !== null && !seen()) open({ search_query: pending || currentQuery() });
  if (cfg.delay > 0 && currentQuery() && !seen()) {
    setTimeout(function () { if (!seen()) open({}); }, cfg.delay * 1000);
  }

  window.LeadGen = { open: open, close: close };
})();
