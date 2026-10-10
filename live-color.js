// Live colour picker. Attack Shark's app opens a hidden <input type=color> and listens for "input"; Firefox's native
// dialog only reports the colour on "Select". This shows an in-page picker instead and feeds the app each colour
// while you drag, so the keyboard changes as you pick.
(() => {
  const SWATCHES = ["#ff0000", "#ff5a00", "#ffd000", "#00ff00", "#00ffa0", "#00ffff", "#0060ff", "#0000ff", "#8000ff", "#ff00ff", "#ff0080", "#ffffff"];
  const EVERY_MS = 120; // at most ~8 keyboard writes a second, so they never queue up
  let px = innerWidth / 2, py = innerHeight / 3;
  addEventListener("pointerdown", (e) => { px = e.clientX; py = e.clientY; }, true);
  const nativeClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () { this.type === "color" ? open(this) : nativeClick.call(this); };
  addEventListener("click", (e) => {
    if (e.target instanceof HTMLInputElement && e.target.type === "color") { e.preventDefault(); open(e.target); }
  }, true);

  const toHsv = (hex) => {
    const n = parseInt(hex.slice(1), 16), r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
    let h = !d ? 0 : max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
    return [h < 0 ? h + 360 : h, max ? d / max : 0, max];
  };
  const toHex = (h, s, v) => {
    const f = (n) => { const k = (n + h / 60) % 6; return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1)))); };
    return "#" + [f(5), f(3), f(1)].map((x) => x.toString(16).padStart(2, "0")).join("");
  };

  function open(input) {
    document.getElementById("lc-pop")?.remove();
    const start = /^#[0-9a-f]{6}$/i.test(input.value) ? input.value.toLowerCase() : "#ff0000";
    let [h, s, v] = toHsv(start), sent = start, last = 0, timer = 0;
    const pop = document.createElement("div");
    pop.id = "lc-pop";
    pop.innerHTML = `<style>
#lc-pop{position:fixed;z-index:2147483647;width:264px;padding:12px;background:#1f2326;color:#eee;border-radius:10px;box-shadow:0 8px 30px #0008;font:14px sans-serif;user-select:none}
#lc-pop .sv{position:relative;height:160px;border-radius:6px;cursor:crosshair;touch-action:none}
#lc-pop .hue{position:relative;height:18px;margin-top:10px;border-radius:9px;cursor:pointer;touch-action:none;background:linear-gradient(to right,red,#ff0,lime,cyan,blue,#f0f,red)}
#lc-pop .dot{position:absolute;width:14px;height:14px;margin:-7px;border:2px solid #fff;border-radius:50%;box-shadow:0 0 2px #000;pointer-events:none}
#lc-pop .bar{position:absolute;top:-2px;width:8px;height:18px;margin-left:-6px;border:2px solid #fff;border-radius:4px;box-shadow:0 0 2px #000;pointer-events:none}
#lc-pop .sw{display:grid;grid-template-columns:repeat(6,1fr);gap:6px;margin-top:10px}
#lc-pop .sw b{height:26px;border-radius:5px;cursor:pointer;border:1px solid #fff3}
#lc-pop .row{display:flex;gap:6px;margin-top:10px;align-items:center}
#lc-pop .prev{width:32px;height:32px;border-radius:6px;border:1px solid #fff3;flex:none}
#lc-pop input{width:0;flex:1;height:32px;background:#111;color:#eee;border:1px solid #444;border-radius:6px;padding:0 8px;font:14px monospace}
#lc-pop button{height:32px;padding:0 10px;border-radius:6px;border:1px solid #555;background:#2c3236;color:#eee;font:14px sans-serif;cursor:pointer}
#lc-pop button.ok{background:#2f8f83;border-color:#2f8f83}
</style><div class="sv"><div class="dot"></div></div><div class="hue"><div class="bar"></div></div>
<div class="sw">${SWATCHES.map((c) => `<b style="background:${c}" data-c="${c}"></b>`).join("")}</div>
<div class="row"><span class="prev"></span><input maxlength="7" spellcheck="false"><button class="x">Cancel</button><button class="ok">Done</button></div>`;
    document.body.appendChild(pop);
    pop.style.left = Math.max(8, Math.min(px - 132, innerWidth - 296)) + "px";
    pop.style.top = Math.max(8, Math.min(py + 14, innerHeight - pop.offsetHeight - 8)) + "px";
    const $ = (q) => pop.querySelector(q), sv = $(".sv"), hue = $(".hue"), hex = $("input");

    const emit = () => {
      const c = toHex(h, s, v);
      if (c === sent) return;
      sent = c; last = Date.now(); input.value = c;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const paint = (fromHex) => {
      const c = toHex(h, s, v);
      sv.style.background = `linear-gradient(to top,#000,transparent),linear-gradient(to right,#fff,${toHex(h, 1, 1)})`;
      $(".dot").style.left = s * 100 + "%"; $(".dot").style.top = (1 - v) * 100 + "%";
      $(".bar").style.left = (h / 360) * 100 + "%";
      $(".prev").style.background = c;
      if (!fromHex) hex.value = c;
      clearTimeout(timer);
      const wait = EVERY_MS - (Date.now() - last);
      wait <= 0 ? emit() : (timer = setTimeout(emit, wait));
    };
    const drag = (el, fn) => el.addEventListener("pointerdown", (e) => {
      el.setPointerCapture(e.pointerId);
      const move = (ev) => { const r = el.getBoundingClientRect(); fn(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height))); paint(); };
      move(e);
      el.onpointermove = move;
      el.onpointerup = () => (el.onpointermove = null);
    });
    drag(sv, (x, y) => { s = x; v = 1 - y; });
    drag(hue, (x) => { h = Math.min(x * 360, 359.9); });
    pop.querySelectorAll(".sw b").forEach((b) => (b.onclick = () => { [h, s, v] = toHsv(b.dataset.c); paint(); }));
    hex.oninput = () => { if (/^#?[0-9a-f]{6}$/i.test(hex.value)) { [h, s, v] = toHsv("#" + hex.value.replace("#", "")); paint(true); } };

    const close = (keep) => {
      clearTimeout(timer);
      if (keep) emit();
      else if (sent !== start) { [h, s, v] = toHsv(start); emit(); }
      input.dispatchEvent(new Event("change", { bubbles: true }));
      pop.remove();
      removeEventListener("pointerdown", outside, true);
      removeEventListener("keydown", keys, true);
    };
    const outside = (e) => { if (!pop.contains(e.target)) close(true); };
    const keys = (e) => { if (e.key === "Escape") close(false); if (e.key === "Enter") close(true); };
    $(".ok").onclick = () => close(true);
    $(".x").onclick = () => close(false);
    setTimeout(() => { addEventListener("pointerdown", outside, true); addEventListener("keydown", keys, true); });
    paint();
  }
})();
