// LeadGEN admin dashboard. No framework; every value from the API goes through esc().
(function () {
  "use strict";
  var STATUSES = ["new", "contacted", "qualified", "closed", "lost"];
  var AREAS = ["GTA", "Waterloo", "Cambridge"];
  var SOURCES = { website: "Website", google_ads: "Google ad" };
  var KEY = "leadgen_admin";
  var token = "";
  var state = { page: 1, perPage: 50, total: 0, sellers: [], openLead: null, editSeller: null };

  function $(id) { return document.getElementById(id); }
  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function store(v) { try { v ? sessionStorage.setItem(KEY, v) : sessionStorage.removeItem(KEY); } catch (e) {} }
  function stored() { try { return sessionStorage.getItem(KEY) || ""; } catch (e) { return ""; } }
  function when(v) { return v ? new Date(v).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""; }
  function money(v) { return v == null ? "" : "$" + Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 }); }
  function safeUrl(u) { return /^https?:\/\//i.test(String(u || "")) ? String(u) : ""; }
  function msg(id, text, isErr) { var el = $(id); el.textContent = text || ""; el.classList.toggle("err", !!isErr); }

  function api(path, opts) {
    opts = opts || {};
    var headers = { Authorization: "Bearer " + token };
    if (opts.body) headers["Content-Type"] = "application/json";
    return fetch(path, { method: opts.method || "GET", headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined })
      .then(function (r) {
        if (r.status === 401) { signOut("That token didn't work. Sign in again."); throw new Error("unauthorized"); }
        if (opts.raw) return r.ok ? r : Promise.reject(new Error("HTTP " + r.status));
        return r.json().then(function (data) {
          if (!r.ok) { var e = new Error(data.error || "HTTP " + r.status); e.fields = data.fields; throw e; }
          return data;
        });
      });
  }
  function fieldErrors(e) {
    if (!e.fields) return e.message;
    return Object.keys(e.fields).map(function (k) { return k.replace(/_/g, " ") + ": " + e.fields[k]; }).join(", ");
  }

  // ---------- sign in ----------
  function signIn(t) {
    token = t;
    return api("/api/admin/stats").then(function (stats) {
      store(t);
      $("signin").hidden = true; $("tabs").hidden = false; $("signout").hidden = false;
      renderStats(stats);
      show("leads");
      loadSellers();
    });
  }
  function signOut(text) {
    token = ""; store("");
    closePanels();
    $("signin").hidden = false; $("tabs").hidden = true; $("signout").hidden = true;
    $("view-leads").hidden = true; $("view-sellers").hidden = true;
    msg("signin-msg", text || "", !!text);
  }
  $("signin").addEventListener("submit", function (ev) {
    ev.preventDefault();
    msg("signin-msg", "Checking...");
    signIn($("tok").value.trim()).catch(function (e) { if (e.message !== "unauthorized") msg("signin-msg", "Could not connect (" + e.message + ")", true); });
  });
  $("signout").addEventListener("click", function () { signOut(); });

  function show(tab) {
    Array.prototype.forEach.call(document.querySelectorAll("#tabs button"), function (b) {
      b.classList.toggle("on", b.dataset.tab === tab);
      b.setAttribute("aria-pressed", b.dataset.tab === tab);
    });
    $("view-leads").hidden = tab !== "leads";
    $("view-sellers").hidden = tab !== "sellers";
    if (tab === "leads") loadLeads(); else renderSellers();
  }
  $("tabs").addEventListener("click", function (ev) { var b = ev.target.closest("button"); if (b) show(b.dataset.tab); });

  // ---------- stats ----------
  function renderStats(s) {
    var n = s.notifications_7_days;
    var cards = [
      [s.leads.today, "Leads today"], [s.leads.last_7_days, "Last 7 days"], [s.leads.last_30_days, "Last 30 days"],
      [s.by_status.new || 0, "New, not contacted"], [n.sent, "Alerts sent (7d)"], [n.failed, "Alerts failed (7d)", n.failed > 0],
    ];
    $("stats").innerHTML = cards.map(function (c) {
      return '<div class="stat' + (c[2] ? " bad" : "") + '"><b>' + esc(c[0]) + "</b><span>" + esc(c[1]) + "</span></div>";
    }).join("");
    function group(title, obj, label) {
      var keys = Object.keys(obj || {});
      return "<div><h3>" + esc(title) + "</h3><dl>" + (keys.length ? keys.map(function (k) {
        return "<dt>" + esc(label ? label(k) : k) + "</dt><dd>" + esc(obj[k]) + "</dd>";
      }).join("") : "<dt>None yet</dt><dd></dd>") + "</dl></div>";
    }
    var syncs = {};
    Object.keys(s.last_sync).forEach(function (k) {
      var r = s.last_sync[k];
      syncs[k] = (r.error ? "error, " : "") + when(r.finished_at || r.started_at) + (r.error ? "" : " (" + r.upserted + " updated)");
    });
    $("stats-more").innerHTML = '<div class="groups">' +
      group("Leads by source", s.by_source, function (k) { return SOURCES[k] || k; }) +
      group("Leads by status", s.by_status) +
      group("Leads by area", s.by_area, function (k) { return k === "none" ? "No area" : k; }) +
      group("Active listings", s.active_listings_by_area, function (k) { return k === "none" ? "No area" : k; }) +
      group("Last listing sync", syncs) + "</div>";
  }
  function refreshStats() { return api("/api/admin/stats").then(renderStats).catch(function () {}); }

  // ---------- leads ----------
  var statusSel = document.querySelector('#filters [name=status]');
  STATUSES.forEach(function (s) { var o = document.createElement("option"); o.value = s; o.textContent = s[0].toUpperCase() + s.slice(1); statusSel.appendChild(o); });

  function filterParams() {
    var p = new URLSearchParams();
    var f = $("filters");
    ["q", "status", "source", "area", "from", "to"].forEach(function (k) { var v = f.elements[k].value.trim(); if (v) p.set(k, v); });
    if (f.elements.include_test.checked) p.set("include_test", "1");
    return p;
  }
  function statusSelect(id, value) {
    return '<select class="status" data-id="' + esc(id) + '" aria-label="Status">' + STATUSES.map(function (s) {
      return '<option value="' + s + '"' + (s === value ? " selected" : "") + ">" + s[0].toUpperCase() + s.slice(1) + "</option>";
    }).join("") + "</select>";
  }
  function notifiedTag(l) {
    return l.last_notification_status ? '<span class="tag ' + esc(l.last_notification_status) + '">' + esc(l.last_notification_channel) + " " + esc(l.last_notification_status) + "</span>" : "";
  }
  function loadLeads() {
    var p = filterParams();
    p.set("page", state.page); p.set("per_page", state.perPage);
    msg("leads-msg", "Loading...");
    return api("/api/admin/leads?" + p).then(function (data) {
      state.total = data.total;
      var tbody = $("leads").tBodies[0];
      tbody.innerHTML = data.leads.map(function (l) {
        var src = (SOURCES[l.source] || l.source) + (l.is_test ? " (test)" : "");
        return '<tr data-id="' + esc(l.id) + '" class="' + (l.is_test ? "test" : "") + '" tabindex="0">' +
          '<td class="c-when">' + esc(when(l.created_at)) + "</td>" +
          '<td class="c-name"><div class="name">' + esc(l.name || "(no name)") + '</div><div class="sub">' + esc([l.intent, l.location].filter(Boolean).join(" · ")) + "</div></td>" +
          '<td class="c-contact">' + esc(l.email || "") + (l.email && l.phone ? "<br>" : "") + esc(l.phone || "") + "</td>" +
          '<td class="c-src"><span class="tag">' + esc(src) + "</span></td>" +
          '<td class="c-area">' + esc(l.area || "") + "</td>" +
          '<td class="c-seller">' + esc(l.seller_name || "") + "</td>" +
          '<td class="c-matches num">' + esc(l.match_count) + "</td>" +
          '<td class="c-notified">' + notifiedTag(l) + "</td>" +
          '<td class="c-meta">' + esc([src, l.area, l.match_count ? l.match_count + (l.match_count === 1 ? " match" : " matches") : "", l.seller_name].filter(Boolean).join(" · ")) + " " + notifiedTag(l) + "</td>" +
          '<td class="c-status">' + statusSelect(l.id, l.status) + "</td></tr>";
      }).join("");
      var pages = Math.max(1, Math.ceil(data.total / state.perPage));
      msg("leads-msg", data.total ? data.total + (data.total === 1 ? " lead" : " leads") : "No leads match these filters.");
      $("page").textContent = "Page " + state.page + " of " + pages;
      $("prev").disabled = state.page <= 1; $("next").disabled = state.page >= pages;
    }).catch(function (e) { if (e.message !== "unauthorized") msg("leads-msg", "Could not load leads: " + fieldErrors(e), true); });
  }
  var searchTimer;
  $("filters").addEventListener("input", function (ev) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { state.page = 1; loadLeads(); }, ev.target.type === "search" ? 300 : 0);
  });
  $("filters").addEventListener("submit", function (ev) { ev.preventDefault(); });
  $("clear").addEventListener("click", function () { $("filters").reset(); state.page = 1; loadLeads(); });
  $("prev").addEventListener("click", function () { state.page--; loadLeads(); });
  $("next").addEventListener("click", function () { state.page++; loadLeads(); });
  $("csv").addEventListener("click", function () {
    var p = filterParams(); p.set("format", "csv");
    api("/api/admin/leads?" + p, { raw: true }).then(function (r) {
      var name = (/filename="([^"]+)"/.exec(r.headers.get("Content-Disposition") || "") || [])[1] || "leads.csv";
      return r.blob().then(function (b) {
        var a = document.createElement("a");
        a.href = URL.createObjectURL(b); a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
      });
    }).catch(function (e) { if (e.message !== "unauthorized") msg("leads-msg", "Export failed: " + e.message, true); });
  });

  function saveStatus(sel) {
    sel.disabled = true;
    return api("/api/admin/leads?id=" + encodeURIComponent(sel.dataset.id), { method: "PATCH", body: { status: sel.value } })
      .then(function (lead) {
        msg("leads-msg", "Saved: " + (lead.name || "lead") + " is now " + lead.status + ".");
        refreshStats();
        if (state.openLead && String(state.openLead.id) === String(lead.id)) renderLead(lead);
        Array.prototype.forEach.call(document.querySelectorAll('select.status[data-id="' + lead.id + '"]'), function (s) { s.value = lead.status; });
      })
      .catch(function (e) { if (e.message !== "unauthorized") msg("leads-msg", "Could not save: " + fieldErrors(e), true); })
      .then(function () { sel.disabled = false; });
  }
  $("leads").addEventListener("change", function (ev) { if (ev.target.matches("select.status")) saveStatus(ev.target); });
  $("leads").addEventListener("click", function (ev) {
    if (ev.target.closest("select")) return;
    var tr = ev.target.closest("tbody tr"); if (tr) openLead(tr.dataset.id);
  });
  $("leads").addEventListener("keydown", function (ev) {
    if (ev.key === "Enter" && ev.target.matches("tbody tr")) openLead(ev.target.dataset.id);
  });

  // ---------- lead panel ----------
  function openPanel(id) { $(id).hidden = false; $("backdrop").hidden = false; document.body.style.overflow = "hidden"; }
  function closePanels() {
    $("lead-panel").hidden = true; $("seller-panel").hidden = true; $("backdrop").hidden = true;
    document.body.style.overflow = ""; state.openLead = null;
  }
  $("backdrop").addEventListener("click", closePanels);
  Array.prototype.forEach.call(document.querySelectorAll("[data-close]"), function (b) { b.addEventListener("click", closePanels); });
  document.addEventListener("keydown", function (ev) { if (ev.key === "Escape") closePanels(); });

  function openLead(id) {
    $("lead-body").innerHTML = '<p class="msg">Loading...</p>';
    openPanel("lead-panel");
    api("/api/admin/leads?id=" + encodeURIComponent(id)).then(renderLead)
      .catch(function (e) { if (e.message !== "unauthorized") $("lead-body").innerHTML = '<p class="msg err">Could not load lead: ' + esc(e.message) + "</p>"; });
  }
  function renderLead(l) {
    state.openLead = l;
    $("lead-title").textContent = l.name || "Lead #" + l.id;
    var tel = l.phone ? String(l.phone).replace(/[^\d+]/g, "") : "";
    var contact = (l.phone ? '<a href="tel:' + esc(tel) + '">Call ' + esc(l.phone) + "</a>" + '<a href="sms:' + esc(tel) + '">Text</a>' : "") +
      (l.email ? '<a href="mailto:' + esc(l.email) + '">' + esc(l.email) + "</a>" : "");
    var facts = [["Received", when(l.created_at)], ["Source", (SOURCES[l.source] || l.source) + (l.is_test ? " (test)" : "")],
      ["Looking to", l.intent], ["Area", l.area], ["Location", l.location], ["Budget", l.budget], ["Searched", l.search_query],
      ["Listing", l.listing_id], ["Message", l.message], ["Updated", when(l.updated_at)]]
      .filter(function (f) { return f[1]; })
      .map(function (f) { return "<dt>" + esc(f[0]) + "</dt><dd>" + esc(f[1]) + "</dd>"; }).join("");
    if (safeUrl(l.page_url)) facts += '<dt>Page</dt><dd><a href="' + esc(safeUrl(l.page_url)) + '" target="_blank" rel="noopener noreferrer">' + esc(l.page_url) + "</a></dd>";
    var sellerOpts = '<option value="">Unassigned</option>' + state.sellers.map(function (s) {
      return '<option value="' + esc(s.id) + '"' + (String(s.id) === String(l.assigned_seller_id) ? " selected" : "") + ">" + esc(s.name) + (s.active ? "" : " (inactive)") + "</option>";
    }).join("");
    var matches = l.matches.length ? '<ul class="list">' + l.matches.map(function (m) {
      var title = esc([m.address, m.city].filter(Boolean).join(", ") || "Listing #" + m.listing_id);
      var url = safeUrl(m.listing_url);
      return "<li>" + (url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + title + "</a>" : title) +
        '<div class="sub">' + esc([money(m.price), m.bedrooms != null ? m.bedrooms + " bd" : "", m.mls_number ? "MLS " + m.mls_number : "", "score " + Math.round(m.score)].filter(Boolean).join(" · ")) +
        (m.listing_status && m.listing_status !== "active" ? ' <span class="tag failed">' + esc(m.listing_status) + "</span>" : "") + "</div></li>";
    }).join("") + "</ul>" : '<p class="msg">No matching listings yet.</p>';
    var notes = l.notifications.length ? '<ul class="list">' + l.notifications.map(function (n) {
      return '<li><span class="tag ' + esc(n.status) + '">' + esc(n.channel) + " " + esc(n.status) + "</span> " + esc(when(n.created_at)) +
        (n.seller_name ? " to " + esc(n.seller_name) : "") + (n.error ? '<div class="sub">' + esc(n.error) + "</div>" : "") + "</li>";
    }).join("") + "</ul>" : '<p class="msg">No alerts sent for this lead.</p>';
    $("lead-body").innerHTML =
      (contact ? '<div class="contact">' + contact + "</div>" : "") +
      '<div class="inline"><label>Status ' + statusSelect(l.id, l.status) + '</label><label>Seller <select id="lead-seller">' + sellerOpts + "</select></label></div>" +
      '<div><h3>Notes</h3><textarea id="lead-notes" maxlength="5000" placeholder="Call notes, next steps...">' + esc(l.notes || "") + '</textarea>' +
      '<div class="inline"><button type="button" class="primary" id="save-notes">Save notes</button><span class="msg" id="lead-msg" role="status"></span></div></div>' +
      '<div><h3>Details</h3><dl class="facts">' + facts + "</dl></div>" +
      "<div><h3>Matching listings (" + l.matches.length + ")</h3>" + matches + "</div>" +
      "<div><h3>Alert history</h3>" + notes + "</div>";
    $("lead-body").querySelector("select.status").addEventListener("change", function (ev) { saveStatus(ev.target); });
    $("lead-seller").addEventListener("change", function (ev) { patchOpenLead({ assigned_seller_id: ev.target.value || null }, "Seller saved."); });
    $("save-notes").addEventListener("click", function () { patchOpenLead({ notes: $("lead-notes").value }, "Notes saved."); });
  }
  function patchOpenLead(body, done) {
    var id = state.openLead.id;
    msg("lead-msg", "Saving...");
    api("/api/admin/leads?id=" + encodeURIComponent(id), { method: "PATCH", body: body })
      .then(function (lead) { renderLead(lead); msg("lead-msg", done); loadLeads(); })
      .catch(function (e) { if (e.message !== "unauthorized") msg("lead-msg", "Could not save: " + fieldErrors(e), true); });
  }

  // ---------- sellers ----------
  $("area-checks").innerHTML = AREAS.map(function (a) {
    return '<label class="check"><input type="checkbox" name="areas" value="' + esc(a) + '"> ' + esc(a) + "</label>";
  }).join("");
  function loadSellers() {
    return api("/api/admin/sellers").then(function (rows) { state.sellers = rows; renderSellers(); })
      .catch(function (e) { if (e.message !== "unauthorized") msg("sellers-msg", "Could not load sellers: " + e.message, true); });
  }
  function renderSellers() {
    msg("sellers-msg", state.sellers.length ? "" : "No sellers yet. Add the realtors who should get new leads.");
    $("sellers").innerHTML = state.sellers.map(function (s) {
      var alerts = [s.notify_email ? "email" : "", s.notify_sms ? "SMS" : ""].filter(Boolean).join(" + ") || "no alerts";
      return '<li class="' + (s.active ? "" : "off") + '"><div><div class="name"><b>' + esc(s.name) + "</b>" + (s.active ? "" : ' <span class="tag">inactive</span>') + "</div>" +
        '<div class="meta">' + esc([s.email, s.phone].filter(Boolean).join(" · ")) + "</div>" +
        '<div class="meta">' + esc((s.areas.length ? s.areas.join(", ") : "All areas") + " · " + alerts) + "</div></div>" +
        '<button type="button" data-edit="' + esc(s.id) + '">Edit</button></li>';
    }).join("");
  }
  function editSeller(s) {
    state.editSeller = s;
    var f = $("seller-form");
    $("seller-title").textContent = s ? "Edit seller" : "Add seller";
    f.elements.name.value = s ? s.name : "";
    f.elements.email.value = s && s.email ? s.email : "";
    f.elements.phone.value = s && s.phone ? s.phone : "";
    Array.prototype.forEach.call(f.querySelectorAll("[name=areas]"), function (c) { c.checked = !!s && s.areas.indexOf(c.value) >= 0; });
    f.elements.notify_email.checked = s ? s.notify_email : true;
    f.elements.notify_sms.checked = s ? s.notify_sms : true;
    f.elements.active.checked = s ? s.active : true;
    msg("seller-msg", "");
    openPanel("seller-panel");
    f.elements.name.focus();
  }
  $("add-seller").addEventListener("click", function () { editSeller(null); });
  $("sellers").addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-edit]"); if (!b) return;
    editSeller(state.sellers.filter(function (s) { return String(s.id) === b.dataset.edit; })[0]);
  });
  $("seller-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var f = ev.target;
    var phone = f.elements.phone.value.replace(/[\s().-]/g, "");
    if (/^\d{10}$/.test(phone)) phone = "+1" + phone; // North American number typed without +1
    else if (/^1\d{10}$/.test(phone)) phone = "+" + phone;
    var body = {
      name: f.elements.name.value, email: f.elements.email.value.trim() || null, phone: phone || null,
      areas: Array.prototype.filter.call(f.querySelectorAll("[name=areas]"), function (c) { return c.checked; }).map(function (c) { return c.value; }),
      notify_email: f.elements.notify_email.checked, notify_sms: f.elements.notify_sms.checked, active: f.elements.active.checked,
    };
    var s = state.editSeller;
    msg("seller-msg", "Saving...");
    api("/api/admin/sellers" + (s ? "?id=" + encodeURIComponent(s.id) : ""), { method: s ? "PATCH" : "POST", body: body })
      .then(function () { closePanels(); msg("sellers-msg", "Saved."); return loadSellers(); })
      .catch(function (e) { if (e.message !== "unauthorized") msg("seller-msg", "Please fix: " + fieldErrors(e), true); });
  });

  // ---------- start ----------
  var saved = stored();
  if (saved) { $("tok").value = saved; signIn(saved).catch(function () {}); }
})();
