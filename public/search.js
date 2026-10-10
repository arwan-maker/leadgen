/* LeadGEN listing search. Plain JS, no build step. Filters live in the URL so searches can be shared. */
(function () {
  var API = "/api/listings";
  var PAGE_SIZE = 12;
  var FILTERS = ["q", "area", "type", "property_type", "min_price", "max_price", "beds", "baths", "sort"];
  var SALE_PRICES = [300000, 400000, 500000, 600000, 700000, 800000, 900000, 1000000, 1250000, 1500000, 2000000, 3000000];
  var LEASE_PRICES = [1000, 1500, 2000, 2500, 3000, 3500, 4000, 5000];

  var form = document.getElementById("search-form");
  var list = document.getElementById("list");
  var stateBox = document.getElementById("state");
  var countEl = document.getElementById("count");
  var pager = document.getElementById("pager");
  var modal = document.getElementById("detail");
  var detailBody = document.getElementById("detail-body");
  var lastFocus = null, requestId = 0, page = 1;

  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  // Only http(s) links and http(s)/data-image photos from the feed are used.
  function safeUrl(u, allowDataImage) {
    u = String(u || "");
    if (/^https?:\/\//i.test(u)) return u;
    if (allowDataImage && /^data:image\/(png|jpe?g|gif|webp|svg\+xml)[;,]/i.test(u)) return u;
    return "";
  }
  function money(n) {
    return n == null ? "Price on request" : "$" + Math.round(n).toLocaleString("en-CA");
  }
  function shortMoney(n) {
    return n >= 1000000 ? "$" + (n / 1000000) + "M" : n >= 10000 ? "$" + n / 1000 + "k" : "$" + n.toLocaleString("en-CA");
  }
  function priceHtml(l) {
    return esc(money(l.price)) + (l.transaction_type === "lease" && l.price != null ? " <small>/month</small>" : "");
  }
  function photos(l) {
    return (Array.isArray(l.photo_urls) ? l.photo_urls : []).map(function (u) { return safeUrl(u, true); }).filter(Boolean);
  }
  function facts(l) {
    var f = [];
    if (l.bedrooms != null) f.push(l.bedrooms + (l.bedrooms === 1 ? " bed" : " beds"));
    if (l.bathrooms != null) f.push(l.bathrooms + (l.bathrooms === 1 ? " bath" : " baths"));
    if (l.sqft) f.push(Number(l.sqft).toLocaleString("en-CA") + " sq ft");
    if (l.property_type) f.push(l.property_type);
    return f;
  }
  function place() {
    var all = Array.prototype.slice.call(arguments);
    return all.filter(function (v, i) { return v && all.indexOf(v) === i; }).join(", ");
  }
  // ---- CREA Analytics Web Service (DDF rule 5(c)): fire-and-forget beacons for crea_ddf listings ----
  var creaConfig = null;
  function creaDestination() {
    if (!creaConfig) creaConfig = fetch("/api/config").then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (c) { return c.creaDestinationId || null; }).catch(function () { return null; });
    return creaConfig;
  }
  var visitorId = null;
  function uuid() {
    if (visitorId) return visitorId;
    try { visitorId = localStorage.getItem("leadgen_uid"); } catch (e) {}
    if (!visitorId) {
      visitorId = window.crypto && crypto.randomUUID ? crypto.randomUUID()
        : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
          var r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 3 | 8)).toString(16);
        });
      try { localStorage.setItem("leadgen_uid", visitorId); } catch (e) {}
    }
    return visitorId;
  }
  function creaEvent(l, type) { // type: view | click | email_realtor
    if (!l || l.source !== "crea_ddf" || !l.source_key) return;
    creaDestination().then(function (dest) {
      if (!dest) return;
      new Image().src = "https://analytics.crea.ca/LogEvents.svc/LogEvents?ListingID=" + encodeURIComponent(l.source_key) +
        "&DestinationID=" + encodeURIComponent(dest) + "&EventType=" + type + "&UUID=" + encodeURIComponent(uuid());
    });
  }

  function contactId(l) { return l.mls_number || l.source_key; }
  // What the searcher was looking for: their typed text, else a summary of the filters ("Cambridge, sale, 3+ beds").
  function currentQuery() {
    var q = form.q.value.trim();
    if (q) return q;
    var parts = [form.area.value, form.type.value, form.property_type.value,
      form.min_price.value && "from " + shortMoney(Number(form.min_price.value)),
      form.max_price.value && "up to " + shortMoney(Number(form.max_price.value)),
      form.beds.value && form.beds.value + "+ beds", form.baths.value && form.baths.value + "+ baths"];
    return parts.filter(Boolean).join(", ");
  }

  // CREA DDF rule 6(a)(ii): the listing brokerage is shown without the consumer having to click.
  function brokerage(l) {
    return l.office_name ? '<div class="office">Listing brokerage: ' + esc(l.office_name) + "</div>" : "";
  }
  // CREA DDF rule 6(a)(i): "Powered by REALTOR.ca" logo, at least 90px wide and 1:1, linking to the listing on REALTOR.ca.
  // TODO: replace this placeholder with CREA's official "Powered by REALTOR.ca" logo file once we have the assets.
  var REALTOR_LOGO = "data:image/svg+xml," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="90" height="90" viewBox="0 0 90 90"><rect width="90" height="90" rx="6" fill="#fff" stroke="#c8102e" stroke-width="2"/>' +
    '<text x="45" y="30" font-family="Arial,sans-serif" font-size="11" text-anchor="middle" fill="#334155">Powered by</text>' +
    '<text x="45" y="52" font-family="Arial,sans-serif" font-size="13" font-weight="bold" text-anchor="middle" fill="#c8102e">REALTOR.ca</text>' +
    '<text x="45" y="74" font-family="Arial,sans-serif" font-size="9" text-anchor="middle" fill="#64748b">(logo TODO)</text></svg>');
  function attribution(l) {
    var url = safeUrl(l.listing_url);
    if (l.source !== "crea_ddf" || !url) return "";
    return '<div class="ddf"><a class="realtor-logo" data-crea-click="' + esc(l.id) + '" href="' + esc(url) + '" target="_blank" rel="noopener">' +
      '<img src="' + REALTOR_LOGO + '" width="90" height="90" alt="Powered by REALTOR.ca: view this listing on REALTOR.ca (opens in a new tab)"></a>' +
      '<span class="attrib">Listing data powered by REALTOR.ca</span></div>';
  }

  // ---- URL <-> form ----
  function fillPriceOptions() {
    var prices = form.type.value === "lease" ? LEASE_PRICES : SALE_PRICES;
    ["min_price", "max_price"].forEach(function (name) {
      var sel = form[name], keep = sel.value;
      sel.length = 1;
      prices.forEach(function (p) { sel.add(new Option(shortMoney(p), String(p))); });
      if (keep && prices.indexOf(Number(keep)) < 0) sel.add(new Option(shortMoney(Number(keep)), keep));
      sel.value = keep;
    });
  }
  function readUrl() {
    var p = new URLSearchParams(location.search);
    FILTERS.forEach(function (k) {
      var el = form.elements[k] || document.getElementById("f-sort");
      if (k === "sort") el = document.getElementById("f-sort");
      var v = p.get(k) || (k === "sort" ? "newest" : "");
      if (el.tagName === "SELECT" && v && !Array.prototype.some.call(el.options, function (o) { return o.value === v; })) {
        if (k === "min_price" || k === "max_price") { if (/^\d+$/.test(v)) el.add(new Option(shortMoney(Number(v)), v)); else v = ""; }
        else v = "";
      }
      el.value = v;
    });
    fillPriceOptions();
    page = Math.max(1, parseInt(p.get("page") || "1", 10) || 1);
    return p.get("listing");
  }
  function params() {
    var p = new URLSearchParams();
    FILTERS.forEach(function (k) {
      var el = k === "sort" ? document.getElementById("f-sort") : form.elements[k];
      var v = el.value.trim();
      if (v && !(k === "sort" && v === "newest")) p.set(k, v);
    });
    if (page > 1) p.set("page", String(page));
    return p;
  }
  function writeUrl(extra, replace) {
    var p = params();
    if (extra) Object.keys(extra).forEach(function (k) { p.set(k, extra[k]); });
    var url = location.pathname + (p.toString() ? "?" + p : "");
    history[replace ? "replaceState" : "pushState"](null, "", url);
  }

  // ---- results ----
  function skeleton() {
    var card = '<li class="card skeleton" aria-hidden="true"><div class="photo"></div><div class="body"><div class="line" style="width:50%"></div><div class="line" style="width:80%"></div><div class="line" style="width:60%"></div></div></li>';
    list.innerHTML = new Array(7).join(card);
    list.setAttribute("aria-busy", "true");
    stateBox.innerHTML = "";
    pager.hidden = true;
    countEl.textContent = "Loading listings…";
  }
  function card(l) {
    var ph = photos(l)[0];
    return '<li class="card">' +
      '<div class="photo">' + (ph ? '<img src="' + esc(ph) + '" alt="Photo of ' + esc(l.address || "listing") + '" loading="lazy">' : "No photo") + "</div>" +
      '<div class="body">' +
      '<div><span class="tag ' + (l.transaction_type === "lease" ? "lease" : "") + '">For ' + (l.transaction_type === "lease" ? "lease" : "sale") + "</span></div>" +
      '<div class="price">' + priceHtml(l) + "</div>" +
      '<h2><a href="?listing=' + esc(l.id) + '" data-open="' + esc(l.id) + '">' + esc(l.address || "Address withheld") + "</a></h2>" +
      '<div class="meta">' + esc(place(l.city, l.area)) + "</div>" +
      '<div class="meta">' + esc(facts(l).join(" · ")) + "</div>" +
      brokerage(l) + attribution(l) +
      '<div class="btns"><button class="btn ghost" type="button" data-open="' + esc(l.id) + '">Details</button>' +
      '<button class="btn" type="button" data-contact="' + esc(l.id) + '">Contact about this home</button></div>' +
      "</div></li>";
  }
  var shown = {};
  function search() {
    if (!termsAccepted()) return showTerms(true);
    var id = ++requestId;
    var p = params();
    p.set("page_size", String(PAGE_SIZE));
    skeleton();
    fetch(API + "?" + p).then(function (r) {
      return r.json().then(function (body) { if (!r.ok) throw new Error(body.error || r.status); return body; });
    }).then(function (data) {
      if (id !== requestId) return;
      list.setAttribute("aria-busy", "false");
      shown = {};
      data.results.forEach(function (l) { shown[l.id] = l; });
      list.innerHTML = data.results.map(card).join("");
      var pages = Math.max(1, Math.ceil(data.total / data.page_size));
      if (!data.total) {
        countEl.textContent = "No listings found";
        stateBox.innerHTML = '<div class="state"><h2>No homes match your search</h2><p>Try a different city or clear some filters.</p>' +
          '<p><button class="btn ghost" type="button" id="empty-contact">Ask an agent to find one for you</button></p></div>';
      } else if (!data.results.length) {
        countEl.textContent = data.total.toLocaleString("en-CA") + " listings";
        stateBox.innerHTML = '<div class="state"><h2>That page is empty</h2><p><a href="#" id="first-page">Go to the first page</a></p></div>';
      } else {
        var from = (data.page - 1) * data.page_size + 1;
        countEl.textContent = "Showing " + from + "–" + (from + data.results.length - 1) + " of " + data.total.toLocaleString("en-CA") + " listings";
      }
      pager.hidden = pages <= 1;
      document.getElementById("pageinfo").textContent = "Page " + data.page + " of " + pages;
      document.getElementById("prev").disabled = data.page <= 1;
      document.getElementById("next").disabled = data.page >= pages;
    }).catch(function (err) {
      if (id !== requestId) return;
      console.error(err);
      list.innerHTML = "";
      list.setAttribute("aria-busy", "false");
      countEl.textContent = "Search unavailable";
      stateBox.innerHTML = '<div class="state" role="alert"><h2>We couldn\'t load listings</h2><p>Please check your filters or try again in a moment.</p>' +
        '<p><button class="btn ghost" type="button" id="retry">Try again</button></p></div>';
    });
  }

  // ---- detail ----
  function openDetail(id, push) {
    if (!/^\d+$/.test(String(id))) return;
    if (!termsAccepted()) return showTerms(true);
    lastFocus = document.activeElement;
    modal.hidden = false;
    document.body.classList.add("locked");
    detailBody.innerHTML = '<button class="close" type="button" aria-label="Close">&times;</button><p class="state" id="d-title">Loading listing…</p>';
    detailBody.focus();
    if (push) writeUrl({ listing: id });
    var show = function (l) { if (!modal.hidden) renderDetail(l); };
    fetch(API + "?id=" + encodeURIComponent(id)).then(function (r) {
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(r.status);
      return r.json();
    }).then(function (l) {
      if (l) return show(l);
      detailBody.innerHTML = '<button class="close" type="button" aria-label="Close">&times;</button><div class="state"><h2 id="d-title">This listing is no longer available</h2><p>It may have sold or been taken off the market.</p></div>';
    }).catch(function () {
      detailBody.innerHTML = '<button class="close" type="button" aria-label="Close">&times;</button><div class="state" role="alert"><h2 id="d-title">We couldn\'t load this listing</h2><p>Please try again.</p></div>';
    });
  }
  function renderDetail(l) {
    var ph = photos(l);
    var url = safeUrl(l.listing_url);
    detailBody.innerHTML = '<button class="close" type="button" aria-label="Close">&times;</button>' +
      (ph.length ? '<div class="gallery" tabindex="0" aria-label="Photos">' + ph.map(function (u, i) {
        return '<img src="' + esc(u) + '" alt="Photo ' + (i + 1) + " of " + ph.length + '"' + (i ? ' loading="lazy"' : "") + ">";
      }).join("") + "</div>" : '<div class="photo" style="margin-bottom:12px;border-radius:10px">No photos</div>') +
      '<div><span class="tag ' + (l.transaction_type === "lease" ? "lease" : "") + '">For ' + (l.transaction_type === "lease" ? "lease" : "sale") + "</span></div>" +
      '<h2 id="d-title">' + priceHtml(l) + "</h2>" +
      '<div class="addr">' + esc(l.address || "Address withheld") + "</div>" +
      '<div class="meta">' + esc(place(l.city, l.area, l.postal_code)) + (l.mls_number ? " · MLS® " + esc(l.mls_number) : "") + "</div>" +
      brokerage(l) +
      '<div class="facts">' + facts(l).map(function (f) { return "<span>" + esc(f) + "</span>"; }).join("") + "</div>" +
      '<div class="cta"><button class="btn" type="button" data-contact="' + esc(l.id) + '">Contact about this home</button>' +
      (url ? '<a class="btn ghost" data-crea-click="' + esc(l.id) + '" href="' + esc(url) + '" target="_blank" rel="noopener">View on ' + (l.source === "crea_ddf" ? "REALTOR.ca" : "listing site") + '<span class="sr-only"> (opens in a new tab)</span></a>' : "") + "</div>" +
      (l.description ? '<p class="desc">' + esc(l.description) + "</p>" : "") +
      attribution(l);
    shown[l.id] = l;
    creaEvent(l, "view");
    detailBody.focus();
  }
  function closeDetail(push) {
    if (modal.hidden) return;
    modal.hidden = true;
    detailBody.innerHTML = "";
    document.body.classList.remove("locked");
    if (push) writeUrl();
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  }

  function contact(listing) {
    if (!window.LeadGen) return;
    var opts = { search_query: currentQuery() };
    if (listing) {
      creaEvent(listing, "email_realtor");
      opts.listing_id = contactId(listing);
      opts.location = [listing.address, listing.city].filter(Boolean).join(", ");
      opts.intent = listing.transaction_type === "lease" ? "rent" : "buy";
    }
    window.LeadGen.open(opts);
  }

  // ---- events ----
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    page = 1;
    writeUrl();
    search();
  });
  form.addEventListener("change", function (e) {
    if (e.target.name === "q") return;
    if (e.target.name === "type") fillPriceOptions();
    page = 1;
    writeUrl();
    search();
  });
  form.addEventListener("reset", function () {
    setTimeout(function () {
      document.getElementById("f-sort").value = "newest";
      fillPriceOptions();
      page = 1; writeUrl(); search();
    }, 0);
  });
  document.getElementById("prev").addEventListener("click", function () { page--; writeUrl(); search(); document.getElementById("results").focus(); });
  document.getElementById("next").addEventListener("click", function () { page++; writeUrl(); search(); document.getElementById("results").focus(); });

  document.addEventListener("click", function (e) {
    var link = e.target.closest ? e.target.closest("[data-crea-click]") : null;
    if (link) creaEvent(shown[link.getAttribute("data-crea-click")], "click");
    var t = e.target.closest ? e.target.closest("[data-open],[data-contact],.close,#retry,#first-page,#empty-contact") : null;
    if (!t) { if (e.target === modal) closeDetail(true); return; }
    if (t.hasAttribute("data-open")) { e.preventDefault(); openDetail(t.getAttribute("data-open"), true); }
    else if (t.hasAttribute("data-contact")) contact(shown[t.getAttribute("data-contact")]);
    else if (t.classList.contains("close")) closeDetail(true);
    else if (t.id === "retry") search();
    else if (t.id === "first-page") { e.preventDefault(); page = 1; writeUrl(); search(); }
    else if (t.id === "empty-contact") contact(null);
  });
  document.addEventListener("auxclick", function (e) { // middle-click "open in new tab" on a REALTOR.ca link
    var link = e.target.closest ? e.target.closest("[data-crea-click]") : null;
    if (link && e.button === 1) creaEvent(shown[link.getAttribute("data-crea-click")], "click");
  });
  document.addEventListener("keydown", function (e) {
    if (modal.hidden || document.getElementById("leadgen-popup")) return;
    if (e.key === "Escape") closeDetail(true);
    if (e.key === "Tab") { // keep focus inside the open listing
      var f = detailBody.querySelectorAll("button,a[href],[tabindex='0']");
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === detailBody)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  window.addEventListener("popstate", function () {
    var listing = readUrl();
    search();
    if (listing) openDetail(listing, false); else closeDetail(false);
  });

  // ---- terms of use click-wrap (CREA DDF rule 6(d)): no listings until accepted, remembered per browser ----
  var TERMS_KEY = "leadgen_terms_v1", termsOk = false;
  var termsBox = document.getElementById("terms");
  function termsAccepted() {
    if (termsOk) return true;
    try { return localStorage.getItem(TERMS_KEY) === "accepted"; } catch (e) { return false; }
  }
  function showTerms(thenStart) {
    termsBox.hidden = false;
    document.body.classList.add("locked");
    termsBox.querySelector("[role=dialog]").focus();
    document.getElementById("accept-terms").onclick = function () {
      termsOk = true;
      try { localStorage.setItem(TERMS_KEY, "accepted"); } catch (e) {}
      termsBox.hidden = true;
      if (modal.hidden) document.body.classList.remove("locked");
      if (thenStart) start();
    };
  }
  document.getElementById("show-terms").addEventListener("click", function (e) { e.preventDefault(); showTerms(false); });

  function start() {
    var initial = readUrl();
    search();
    if (initial) openDetail(initial, false);
  }
  if (termsAccepted()) start();
  else {
    readUrl();
    countEl.textContent = "Please accept the terms of use to see listings.";
    list.setAttribute("aria-busy", "false");
    showTerms(true);
  }
})();
