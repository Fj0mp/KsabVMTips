/* Kontorets VM-tips — statisk app mot Svenska Spels öppna API.
   All data (omgångar + kuponger) lagras i localStorage och kan
   exporteras till data.json för delning via GitHub-repot. */

(() => {
  "use strict";

  const STORAGE_KEY = "vmtips_store_v1";
  const SIGNS = ["1", "X", "2"];
  const API_BASE = "https://api.spela.svenskaspel.se/draw/1/europatipset/draws/";

  // Publika CORS-proxies som fallback (API:et saknar Access-Control-Allow-Origin).
  const PROXIES = [
    (u) => u, // försök direkt först
    (u) => "https://corsproxy.io/?url=" + encodeURIComponent(u),
    (u) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u),
    (u) => "https://thingproxy.freeboard.io/fetch/" + u,
  ];

  const drawCache = new Map(); // drawNumber -> draw object
  let store = { title: "Kontorets VM-tips", rounds: [] };
  let currentRoundId = null;

  /* ---------- DOM helpers ---------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const el = (tag, attrs = {}, children = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
      else if (k === "html") n.innerHTML = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined) n.setAttribute(k, v);
    }
    (Array.isArray(children) ? children : [children]).forEach((c) => {
      if (c == null) return;
      n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return n;
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let toastTimer;
  function toast(msg, kind = "") {
    const t = $("#toast");
    t.textContent = msg;
    t.className = "toast " + kind;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add("hidden"), 3200);
  }

  /* ---------- Persistence ---------- */
  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); }
    catch (e) { toast("Kunde inte spara lokalt: " + e.message, "err"); }
  }

  async function loadStore() {
    const local = localStorage.getItem(STORAGE_KEY);
    if (local) {
      try { store = JSON.parse(local); return; } catch (_) { /* fall through */ }
    }
    // Första besöket: seeda från data.json i repot om den finns.
    try {
      const res = await fetch("data.json", { cache: "no-store" });
      if (res.ok) {
        const seed = await res.json();
        store = normalize(seed);
        save();
        return;
      }
    } catch (_) { /* offline / file:// — starta tomt */ }
    store = { title: "Kontorets VM-tips", rounds: [] };
  }

  function normalize(data) {
    return {
      title: data.title || "Kontorets VM-tips",
      rounds: (data.rounds || []).map((r) => ({
        id: r.id || "r" + r.drawNumber,
        drawNumber: Number(r.drawNumber),
        name: r.name || "Omgång " + r.drawNumber,
        createdAt: r.createdAt || new Date().toISOString(),
        coupons: (r.coupons || []).map((c) => ({ player: c.player, picks: c.picks || {} })),
      })),
    };
  }

  /* ---------- API ---------- */
  async function fetchDraw(drawNumber, { force = false } = {}) {
    if (!force && drawCache.has(drawNumber)) return drawCache.get(drawNumber);
    const url = API_BASE + drawNumber;
    let lastErr;
    for (const proxy of PROXIES) {
      try {
        const res = await fetch(proxy(url), { cache: "no-store" });
        if (!res.ok) { lastErr = new Error("HTTP " + res.status); continue; }
        const json = await res.json();
        const draw = json.draw || json;
        if (!draw || !draw.drawEvents) { lastErr = new Error("Oväntat svar"); continue; }
        drawCache.set(drawNumber, draw);
        return draw;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error("Kunde inte hämta omgång " + drawNumber);
  }

  /* ---------- Domain helpers ---------- */
  // Faktiskt utfall (1/X/2) för en match, eller null om inte avgjord.
  function eventOutcome(ev) {
    if (ev.cancelled) return null;
    const ft = (ev.match && ev.match.result || []).find((r) => r.sportEventResultType === "Fulltime");
    if (!ft) return null;
    const h = parseInt(ft.home, 10), a = parseInt(ft.away, 10);
    if (isNaN(h) || isNaN(a)) return null;
    return h > a ? "1" : h < a ? "2" : "X";
  }
  function fulltimeScore(ev) {
    const ft = (ev.match && ev.match.result || []).find((r) => r.sportEventResultType === "Fulltime");
    return ft ? `${ft.home}–${ft.away}` : "";
  }
  function teams(ev) {
    const p = (ev.match && ev.match.participants) || [];
    const home = p.find((x) => x.type === "home");
    const away = p.find((x) => x.type === "away");
    if (home && away) return { home: home.name, away: away.name };
    const parts = (ev.eventDescription || "").split(" - ");
    return { home: parts[0] || "Hemma", away: parts[1] || "Borta" };
  }
  // Spelfördelning (svenska folket) i procent för 1/X/2.
  function distribution(ev) {
    const sf = ev.svenskaFolket;
    if (sf) return { "1": +sf.one || 0, "X": +sf.x || 0, "2": +sf.two || 0 };
    const vals = ev.betMetrics && ev.betMetrics.values;
    if (vals) {
      const out = { "1": 0, "X": 0, "2": 0 };
      vals.forEach((v) => { out[v.outcome] = +(v.distribution && v.distribution.distribution) || 0; });
      return out;
    }
    return null;
  }

  function scoreCoupon(coupon, draw) {
    let correct = 0, settled = 0, total = 0, stillPossible = 0;
    for (const ev of draw.drawEvents) {
      if (ev.cancelled) continue;
      total++;
      const out = eventOutcome(ev);
      const picks = coupon.picks[String(ev.eventNumber)] || [];
      if (out) {
        settled++;
        if (picks.includes(out)) correct++;
      } else if (picks.length) {
        stillPossible++;
      }
    }
    return { correct, settled, total, maxPossible: correct + stillPossible };
  }

  function roundById(id) { return store.rounds.find((r) => r.id === id); }
  function allPlayers() {
    const set = new Set();
    store.rounds.forEach((r) => r.coupons.forEach((c) => set.add(c.player)));
    return Array.from(set).sort((a, b) => a.localeCompare(b, "sv"));
  }

  const fmtDate = (iso) => {
    try {
      return new Intl.DateTimeFormat("sv-SE", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
    } catch (_) { return iso || ""; }
  };

  /* ---------- Rendering ---------- */
  function renderRoundSelect() {
    const sel = $("#roundSelect");
    sel.innerHTML = "";
    const sorted = [...store.rounds].sort((a, b) => b.drawNumber - a.drawNumber);
    if (!sorted.length) {
      sel.appendChild(el("option", { text: "—" }));
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    sorted.forEach((r) => sel.appendChild(el("option", { value: r.id, text: `${r.name} (#${r.drawNumber})` })));
    if (!currentRoundId || !roundById(currentRoundId)) currentRoundId = sorted[0].id;
    sel.value = currentRoundId;
  }

  async function renderCurrentRound() {
    const hero = $("#roundHero");
    const content = $("#content");
    const empty = $("#emptyState");
    const load = $("#loadState");

    if (!store.rounds.length) {
      empty.classList.remove("hidden");
      hero.classList.add("hidden");
      content.classList.add("hidden");
      load.classList.add("hidden");
      return;
    }
    empty.classList.add("hidden");

    const round = roundById(currentRoundId);
    if (!round) return;

    load.classList.remove("hidden");
    content.classList.add("hidden");
    hero.classList.add("hidden");

    let draw;
    try {
      draw = await fetchDraw(round.drawNumber);
    } catch (e) {
      load.classList.add("hidden");
      hero.classList.remove("hidden");
      hero.innerHTML = "";
      hero.appendChild(el("div", { class: "notice warn" },
        `Kunde inte hämta omgång #${round.drawNumber} från API:et (${esc(e.message)}). ` +
        `Kontrollera nätverket eller försök igen. Kupongerna finns kvar lokalt.`));
      return;
    }

    load.classList.add("hidden");
    hero.classList.remove("hidden");
    content.classList.remove("hidden");

    renderHero(round, draw);
    renderLeaderboard(round, draw);
    renderMatches(round, draw);
  }

  function roundProgress(draw) {
    let settled = 0, total = 0;
    draw.drawEvents.forEach((ev) => { if (!ev.cancelled) { total++; if (eventOutcome(ev)) settled++; } });
    return { settled, total };
  }

  function renderHero(round, draw) {
    const hero = $("#roundHero");
    const { settled, total } = roundProgress(draw);
    let badgeClass = "state-closed", badgeText = "Ej avgjord";
    if (settled === total && total > 0) { badgeClass = "state-final"; badgeText = "Avgjord"; }
    else if (settled > 0) { badgeClass = "state-open"; badgeText = "Pågår"; }
    else if (draw.drawState === "Open") { badgeClass = "state-open"; badgeText = "Öppen för spel"; }

    hero.innerHTML = "";
    hero.appendChild(el("div", { class: "hero-top" }, [
      el("h2", { text: round.name }),
      el("span", { class: "state-badge " + badgeClass, text: badgeText }),
    ]));
    const close = draw.regCloseTime ? `Stänger ${fmtDate(draw.regCloseTime)}` : "";
    hero.appendChild(el("div", { class: "hero-meta" }, [
      heroStat(`${settled}/${total}`, "Avgjorda matcher"),
      heroStat(String(round.coupons.length), "Deltagare"),
      heroStat("#" + round.drawNumber, draw.productName || "Omgång"),
      close ? heroStat("", close, true) : null,
    ]));
  }
  function heroStat(value, label, labelOnly = false) {
    return el("div", { class: "hero-stat" }, [
      labelOnly ? null : el("span", { class: "v", text: value }),
      el("span", { class: "l", text: label }),
    ]);
  }

  function renderLeaderboard(round, draw) {
    const list = $("#leaderboard");
    const info = $("#settledInfo");
    const { settled, total } = roundProgress(draw);
    info.textContent = `${settled} av ${total} matcher klara`;
    list.innerHTML = "";

    if (!round.coupons.length) {
      list.appendChild(el("li", { class: "lb-sub", style: "padding:18px;text-align:center;list-style:none;" },
        "Inga kuponger ännu. Lägg till deltagare via Hantera."));
      return;
    }

    const rows = round.coupons.map((c) => ({ coupon: c, ...scoreCoupon(c, draw) }));
    rows.sort((a, b) => b.correct - a.correct || b.maxPossible - a.maxPossible || a.coupon.player.localeCompare(b.coupon.player, "sv"));
    const maxScale = Math.max(total, 1);

    rows.forEach((row, i) => {
      const rank = i + 1;
      const li = el("li", { class: "lb-row" + (rank <= 3 ? " top" + rank : ""), onclick: () => openPlayerModal(round, draw, row.coupon) }, [
        el("div", { class: "lb-rank", text: String(rank) }),
        el("div", {}, [
          el("div", { class: "lb-name", text: row.coupon.player }),
          el("div", { class: "lb-sub", text: settled < total ? `Max möjligt: ${row.maxPossible}` : "Slutresultat" }),
        ]),
        el("div", { class: "lb-score" }, [
          el("div", {}, [
            el("span", { class: "big", text: String(row.correct) }),
            el("span", { class: "small", text: ` rätt` }),
          ]),
          el("div", { class: "score-bar" }, el("i", { style: `width:${(row.correct / maxScale) * 100}%` })),
        ]),
      ]);
      list.appendChild(li);
    });
  }

  function renderMatches(round, draw) {
    const wrap = $("#matchList");
    wrap.innerHTML = "";
    draw.drawEvents.forEach((ev) => {
      const t = teams(ev);
      const out = eventOutcome(ev);
      const cancelled = ev.cancelled;
      const score = fulltimeScore(ev);
      const row = el("div", { class: "match-row", onclick: () => openMatchModal(round, draw, ev) }, [
        el("div", { class: "match-num", text: String(ev.eventNumber) }),
        el("div", {}, [
          el("div", { class: "match-teams", text: `${t.home} – ${t.away}` }),
          el("div", { class: "match-when", text: cancelled ? "Inställd" : (out ? "Slutresultat" : fmtDate(ev.match && ev.match.matchStart)) }),
        ]),
        el("div", { class: "match-result" }, [
          score ? el("span", { class: "match-score", text: score }) : null,
          el("div", { class: "sign-badge" + (out ? " settled" : ""), text: out || "–" }),
        ]),
      ]);
      wrap.appendChild(row);
    });
  }

  /* ---------- Player modal (full coupon) ---------- */
  function openPlayerModal(round, draw, coupon) {
    const s = scoreCoupon(coupon, draw);
    const body = el("div", {}, [
      el("h3", { text: coupon.player }),
      el("div", { class: "sub", text: `${round.name} · ${s.correct} rätt${s.settled < s.total ? ` (max ${s.maxPossible})` : ""} av ${s.total}` }),
    ]);
    const table = el("table", { class: "coupon-table" });
    table.appendChild(el("thead", {}, el("tr", {}, [
      el("th", { text: "#" }), el("th", { text: "Match" }), el("th", { text: "Tips" }), el("th", { text: "Resultat" }), el("th", { text: "" }),
    ])));
    const tb = el("tbody");
    draw.drawEvents.forEach((ev) => {
      const t = teams(ev);
      const out = eventOutcome(ev);
      const picks = coupon.picks[String(ev.eventNumber)] || [];
      const hit = out && picks.includes(out);
      // markera rätt/fel per tecken
      const chipEls = picks.length ? picks.map((s) =>
        el("span", { class: "pick-chip" + (out ? (s === out ? " correct" : " wrong") : ""), text: s })) : [el("span", { class: "lb-sub", text: "–" })];
      const tr = el("tr", { class: hit ? "row-correct" : "" }, [
        el("td", { text: String(ev.eventNumber) }),
        el("td", { text: `${t.home} – ${t.away}` }),
        el("td", {}, chipEls),
        el("td", {}, [
          el("span", { class: "res-tag", text: ev.cancelled ? "Inställd" : (out || "–") }),
          out ? el("span", { class: "lb-sub", text: " " + fulltimeScore(ev) }) : null,
        ]),
        el("td", { html: out ? (hit ? '<span class="tick">✓</span>' : '<span class="cross">✕</span>') : "" }),
      ]);
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    body.appendChild(table);
    openModal(body);
  }

  /* ---------- Match modal (who picked what) ---------- */
  function openMatchModal(round, draw, ev) {
    const t = teams(ev);
    const out = eventOutcome(ev);
    const dist = distribution(ev);
    const body = el("div", {}, [
      el("h3", { text: `${t.home} – ${t.away}` }),
      el("div", { class: "sub", text: `Match ${ev.eventNumber} · ${ev.cancelled ? "Inställd" : (out ? `Slutresultat ${fulltimeScore(ev)} (${out})` : fmtDate(ev.match && ev.match.matchStart))}` }),
    ]);

    if (dist) {
      const maxPct = Math.max(dist["1"], dist["X"], dist["2"], 1);
      const distEl = el("div", { class: "dist", style: "margin-bottom:6px;" }, SIGNS.map((s) =>
        el("div", { class: "dist-seg" + (out === s ? " win" : "") }, [
          el("span", { class: "lab", text: s }),
          el("div", { class: "barwrap" }, el("div", { class: "bar", style: `height:${(dist[s] / maxPct) * 100}%` })),
          el("span", { class: "pct", text: dist[s] + "%" }),
        ])));
      body.appendChild(el("div", { class: "lb-sub", style: "margin-bottom:6px;", text: "Svenska folket" }));
      body.appendChild(distEl);
    }

    // Gruppera deltagare per tecken
    const groups = { "1": [], "X": [], "2": [], "—": [] };
    round.coupons.forEach((c) => {
      const picks = c.picks[String(ev.eventNumber)] || [];
      if (!picks.length) groups["—"].push(c.player);
      else picks.forEach((s) => { if (groups[s]) groups[s].push(c.player); });
    });

    const grid = el("div", { class: "voters-grid" }, SIGNS.map((s) =>
      el("div", { class: "voter-col" + (out === s ? " win" : "") }, [
        el("h4", {}, [
          el("span", { text: s === "1" ? "1 — " + t.home : s === "2" ? "2 — " + t.away : "X — Oavgjort" }),
          el("span", { class: "vsign", text: s }),
        ]),
        groups[s].length
          ? el("ul", { class: "voter-list" }, groups[s].map((p) => el("li", { text: p })))
          : el("ul", { class: "voter-list" }, el("li", { class: "none", text: "Ingen" })),
      ])));
    body.appendChild(grid);

    if (groups["—"].length) {
      body.appendChild(el("div", { class: "lb-sub", style: "margin-top:14px;", text: "Utan tips: " + groups["—"].join(", ") }));
    }
    openModal(body);
  }

  /* ---------- Modal plumbing ---------- */
  function openModal(node) {
    const body = $("#modalBody");
    body.innerHTML = "";
    body.appendChild(node);
    $("#modal").classList.remove("hidden");
  }
  function closeModal() { $("#modal").classList.add("hidden"); }

  /* ---------- Admin drawer ---------- */
  function openAdmin() { renderAdmin(); $("#adminDrawer").classList.remove("hidden"); }
  function closeAdmin() { $("#adminDrawer").classList.add("hidden"); }

  function renderAdmin() {
    const body = $("#adminBody");
    body.innerHTML = "";

    // --- Skapa omgång ---
    const createSec = el("div", { class: "admin-section" }, [
      el("h3", { text: "Skapa spelomgång" }),
      el("p", { class: "desc", text: "Ange omgångsnumret (drawNumber) från Svenska Spel. Hittas i API-url:en, t.ex. .../draws/2583." }),
    ]);
    const numInput = el("input", { type: "number", id: "newDrawNum", placeholder: "t.ex. 2583" });
    const nameInput = el("input", { type: "text", id: "newDrawName", placeholder: "Namn (valfritt, hämtas annars)" });
    createSec.appendChild(el("div", { class: "inline-fields" }, [
      el("div", { class: "field" }, [el("label", { text: "Omgångsnummer" }), numInput]),
      el("div", { class: "field" }, [el("label", { text: "Namn" }), nameInput]),
    ]));
    const createBtn = el("button", { class: "btn btn-primary", onclick: () => createRound(numInput, nameInput, createBtn) }, "Hämta & skapa omgång");
    createSec.appendChild(el("div", { class: "row-actions" }, createBtn));
    body.appendChild(createSec);

    body.appendChild(el("hr", { class: "divider" }));

    // --- Hantera kuponger i vald omgång ---
    if (store.rounds.length) {
      const round = roundById(currentRoundId) || store.rounds[0];
      const couponSec = el("div", { class: "admin-section" }, [
        el("h3", { text: "Kuponger – " + round.name }),
        el("p", { class: "desc", text: "Lägg till eller redigera deltagarnas tips för denna omgång." }),
      ]);
      const addBtn = el("button", { class: "btn btn-ghost btn-sm", onclick: () => openCouponEditor(round, null) }, "+ Ny kupong");
      couponSec.appendChild(el("div", { class: "row-actions" }, addBtn));

      const list = el("ul", { class: "managed-list" });
      if (!round.coupons.length) {
        list.appendChild(el("li", {}, el("span", { class: "mi-sub", text: "Inga kuponger ännu." })));
      }
      round.coupons.forEach((c) => {
        const filled = Object.values(c.picks).filter((p) => p && p.length).length;
        list.appendChild(el("li", {}, [
          el("div", {}, [el("div", { class: "mi-main", text: c.player }), el("div", { class: "mi-sub", text: `${filled} tippade matcher` })]),
          el("div", { class: "managed-actions" }, [
            el("button", { class: "btn btn-ghost btn-sm", onclick: () => openCouponEditor(round, c) }, "Redigera"),
            el("button", { class: "btn btn-danger btn-sm", onclick: () => { if (confirm(`Ta bort ${c.player}s kupong?`)) { round.coupons = round.coupons.filter((x) => x !== c); save(); renderAdmin(); renderCurrentRound(); } } }, "Ta bort"),
          ]),
        ]));
      });
      couponSec.appendChild(list);
      body.appendChild(couponSec);

      body.appendChild(el("hr", { class: "divider" }));
    }

    // --- Hantera omgångar ---
    const roundsSec = el("div", { class: "admin-section" }, [el("h3", { text: "Registrerade omgångar" })]);
    const rlist = el("ul", { class: "managed-list" });
    if (!store.rounds.length) rlist.appendChild(el("li", {}, el("span", { class: "mi-sub", text: "Inga omgångar." })));
    [...store.rounds].sort((a, b) => b.drawNumber - a.drawNumber).forEach((r) => {
      rlist.appendChild(el("li", {}, [
        el("div", {}, [el("div", { class: "mi-main", text: r.name }), el("div", { class: "mi-sub", text: `#${r.drawNumber} · ${r.coupons.length} deltagare` })]),
        el("div", { class: "managed-actions" }, [
          el("button", { class: "btn btn-ghost btn-sm", onclick: () => { currentRoundId = r.id; renderRoundSelect(); renderAdmin(); renderCurrentRound(); } }, "Visa"),
          el("button", { class: "btn btn-danger btn-sm", onclick: () => { if (confirm(`Ta bort omgång ${r.name}?`)) { store.rounds = store.rounds.filter((x) => x !== r); if (currentRoundId === r.id) currentRoundId = null; save(); renderRoundSelect(); renderAdmin(); renderCurrentRound(); } } }, "Ta bort"),
        ]),
      ]));
    });
    roundsSec.appendChild(rlist);
    body.appendChild(roundsSec);

    body.appendChild(el("hr", { class: "divider" }));

    // --- Import / export ---
    const dataSec = el("div", { class: "admin-section" }, [
      el("h3", { text: "Dela & säkerhetskopiera" }),
      el("p", { class: "desc", text: "Exportera data.json och lägg in den i GitHub-repot så ser alla samma kuponger och topplista." }),
      el("div", { class: "notice info", text: "Tips: ersätt filen data.json i repot med den exporterade filen och pusha. Den laddas vid första besöket." }),
    ]);
    dataSec.appendChild(el("div", { class: "row-actions" }, [
      el("button", { class: "btn btn-primary btn-sm", onclick: exportData }, "⬇ Exportera data.json"),
      el("button", { class: "btn btn-ghost btn-sm", onclick: importData }, "⬆ Importera JSON"),
      el("button", { class: "btn btn-ghost btn-sm", onclick: () => fetchDrawFresh() }, "↻ Töm cache & hämta om"),
      el("button", { class: "btn btn-danger btn-sm", onclick: resetLocal }, "Återställ lokalt"),
    ]));
    body.appendChild(dataSec);
  }

  async function createRound(numInput, nameInput, btn) {
    const num = parseInt(numInput.value, 10);
    if (!num) { toast("Ange ett giltigt omgångsnummer", "err"); return; }
    if (store.rounds.some((r) => r.drawNumber === num)) { toast("Omgången finns redan", "err"); return; }
    btn.disabled = true; btn.textContent = "Hämtar…";
    try {
      const draw = await fetchDraw(num, { force: true });
      const round = {
        id: "r" + num,
        drawNumber: num,
        name: nameInput.value.trim() || draw.drawComment || draw.productName || ("Omgång " + num),
        createdAt: new Date().toISOString(),
        coupons: [],
      };
      store.rounds.push(round);
      currentRoundId = round.id;
      save();
      renderRoundSelect();
      renderAdmin();
      renderCurrentRound();
      toast(`Omgång #${num} skapad (${draw.drawEvents.length} matcher)`, "ok");
    } catch (e) {
      toast("Kunde inte hämta omgången: " + e.message, "err");
    } finally {
      btn.disabled = false; btn.textContent = "Hämta & skapa omgång";
    }
  }

  async function openCouponEditor(round, existing) {
    let draw;
    try { draw = await fetchDraw(round.drawNumber); }
    catch (e) { toast("Kunde inte hämta matcher: " + e.message, "err"); return; }

    const isNew = !existing;
    const picks = {};
    if (existing) for (const [k, v] of Object.entries(existing.picks)) picks[k] = [...v];

    const body = el("div", {}, [
      el("h3", { text: isNew ? "Ny kupong" : "Redigera kupong" }),
      el("div", { class: "sub", text: round.name }),
    ]);

    const nameField = el("input", { type: "text", placeholder: "Deltagarens namn", value: existing ? existing.player : "" });
    if (isNew) {
      const players = allPlayers();
      const dl = el("datalist", { id: "playersDl" }, players.map((p) => el("option", { value: p })));
      nameField.setAttribute("list", "playersDl");
      body.appendChild(el("div", { class: "field" }, [el("label", { text: "Namn" }), nameField, dl]));
    } else {
      body.appendChild(el("div", { class: "field" }, [el("label", { text: "Namn" }), nameField]));
    }

    body.appendChild(el("div", { class: "notice info", text: "Klicka 1, X eller 2 per match. Du kan välja flera tecken (gardering) på samma match." }));

    const matchesWrap = el("div", {});
    draw.drawEvents.forEach((ev) => {
      const t = teams(ev);
      const key = String(ev.eventNumber);
      const group = el("div", { class: "sign-group" }, SIGNS.map((s) => {
        const active = (picks[key] || []).includes(s);
        const b = el("button", { class: "sign-btn" + (active ? " active" : ""), text: s });
        b.addEventListener("click", () => {
          const cur = new Set(picks[key] || []);
          if (cur.has(s)) cur.delete(s); else cur.add(s);
          picks[key] = SIGNS.filter((x) => cur.has(x));
          b.classList.toggle("active");
        });
        return b;
      }));
      matchesWrap.appendChild(el("div", { class: "ce-match" }, [
        el("div", { class: "ce-teams" }, [
          el("div", { text: `${t.home} – ${t.away}` }),
          el("span", { class: "n", text: `Match ${ev.eventNumber}` }),
        ]),
        group,
      ]));
    });
    body.appendChild(matchesWrap);

    const saveBtn = el("button", { class: "btn btn-primary" }, "Spara kupong");
    saveBtn.addEventListener("click", () => {
      const name = nameField.value.trim();
      if (!name) { toast("Ange ett namn", "err"); return; }
      const clean = {};
      for (const [k, v] of Object.entries(picks)) if (v && v.length) clean[k] = v;
      if (existing) { existing.player = name; existing.picks = clean; }
      else {
        if (round.coupons.some((c) => c.player.toLowerCase() === name.toLowerCase())) { toast("Deltagaren har redan en kupong", "err"); return; }
        round.coupons.push({ player: name, picks: clean });
      }
      save();
      closeModal();
      renderAdmin();
      renderCurrentRound();
      toast("Kupong sparad", "ok");
    });
    body.appendChild(el("div", { class: "row-actions", style: "margin-top:18px;" }, [
      saveBtn,
      el("button", { class: "btn btn-ghost", onclick: closeModal }, "Avbryt"),
    ]));

    openModal(body);
  }

  function exportData() {
    const blob = new Blob([JSON.stringify(store, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: "data.json" });
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast("data.json exporterad", "ok");
  }

  function importData() {
    const inp = el("input", { type: "file", accept: "application/json,.json" });
    inp.addEventListener("change", () => {
      const file = inp.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          store = normalize(JSON.parse(reader.result));
          currentRoundId = null;
          drawCache.clear();
          save();
          renderRoundSelect();
          renderAdmin();
          renderCurrentRound();
          toast("Data importerad", "ok");
        } catch (e) { toast("Ogiltig JSON: " + e.message, "err"); }
      };
      reader.readAsText(file);
    });
    inp.click();
  }

  function resetLocal() {
    if (!confirm("Återställ lokal data till data.json från repot? Lokala ändringar försvinner.")) return;
    localStorage.removeItem(STORAGE_KEY);
    drawCache.clear();
    currentRoundId = null;
    loadStore().then(() => { renderRoundSelect(); renderAdmin(); renderCurrentRound(); toast("Återställd", "ok"); });
  }

  async function fetchDrawFresh() {
    drawCache.clear();
    toast("Hämtar om…");
    await renderCurrentRound();
  }

  /* ---------- Wire up ---------- */
  function init() {
    $("#roundSelect").addEventListener("change", (e) => { currentRoundId = e.target.value; renderCurrentRound(); });
    $("#refreshBtn").addEventListener("click", async (e) => {
      e.currentTarget.classList.add("loading");
      drawCache.delete(roundById(currentRoundId)?.drawNumber);
      await renderCurrentRound();
      e.currentTarget.classList.remove("loading");
    });
    $("#adminBtn").addEventListener("click", openAdmin);
    $("#adminClose").addEventListener("click", closeAdmin);
    $("#modalClose").addEventListener("click", closeModal);
    $("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
    $("#adminDrawer").addEventListener("click", (e) => { if (e.target.id === "adminDrawer") closeAdmin(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeModal(); closeAdmin(); } });
    $$('[data-action="open-admin"]').forEach((b) => b.addEventListener("click", openAdmin));

    loadStore().then(() => {
      $("#appTitle").textContent = store.title || "Kontorets VM-tips";
      renderRoundSelect();
      renderCurrentRound();
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
