'use strict';
/**
 * render.js — the public card page, in the Linktree mould.
 *
 * A published card has a shareable URL — /@handle and /c/<code> — that renders a
 * clean, mobile-first profile: a round avatar, name, bio, a vertical stack of
 * full-width buttons (the Connect action first, then the owner's links), and a
 * share card with the code, a copy button and a scannable QR. Vibrant gradient,
 * frosted-glass buttons, generous spacing. The page only ever shows public
 * fields; it is handed a card already shaped by publicCard().
 */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function chip(text) { return `<span class="chip">${esc(text)}</span>`; }

function linkButton(l) {
  if (!l || !l.url) return '';
  let host = '';
  try { host = new URL(l.url).hostname.replace(/^www\./, ''); } catch { /* keep empty */ }
  const label = esc(l.label || host);
  const initial = (l.label || host || '?').trim().charAt(0).toUpperCase();
  return `<a class="btn" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">
    <span class="btn-ic">${esc(initial)}</span>
    <span class="btn-label">${label}</span>
    <span class="btn-ic btn-ic--ghost" aria-hidden="true">↗</span>
  </a>`;
}

/**
 * @param card      public card (handle, code, display_name, headline, bio, …)
 * @param opts.shareUrl     the canonical URL of this page (what the QR encodes)
 * @param opts.qrSvg        an <svg> string of the QR for shareUrl (may be '')
 * @param opts.agentJsonUrl the A2A agent.json URL for this card
 */
function cardPage(card, { shareUrl = '', qrSvg = '', agentJsonUrl } = {}) {
  const name = esc(card.display_name || card.handle || 'An agent');
  const handle = card.handle ? '@' + esc(card.handle) : '';
  const initial = (card.display_name || card.handle || '?').trim().charAt(0).toUpperCase();
  const avatar = card.avatar
    ? `<img class="avatar" src="${esc(card.avatar)}" alt="${name}">`
    : `<div class="avatar avatar--fallback">${esc(initial)}</div>`;
  const skills = (card.skills || []).map(chip).join('');
  const stack = (card.stack || []).map(chip).join('');
  const links = (card.links || []).map(linkButton).join('');
  const bio = card.bio ? `<p class="bio">${esc(card.bio).replace(/\n/g, '<br>')}</p>` : '';
  const kind = card.agent_kind ? `<span class="kind">${esc(card.agent_kind)}</span>` : '';
  const title = `${name}${handle ? ' (' + handle + ')' : ''} · agent-card`;
  const code = card.code ? esc(card.code) : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(card.headline || name + "'s agent card")}">
<meta property="og:title" content="${esc(name)}">
<meta property="og:description" content="${esc(card.headline || 'Agent card')}">
<style>
  :root{
    --ink:#ffffff;
    --ink-soft:rgba(255,255,255,.72);
    --ink-dim:rgba(255,255,255,.52);
    --glass:rgba(255,255,255,.12);
    --glass-hi:rgba(255,255,255,.22);
    --line:rgba(255,255,255,.22);
    --accent:#2b1769;        /* text on the solid white primary button */
    --radius:18px;
  }
  *{box-sizing:border-box}
  html,body{margin:0}
  body{
    min-height:100dvh;
    font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    color:var(--ink);
    -webkit-font-smoothing:antialiased;
    background:
      radial-gradient(1100px 520px at 18% -8%, rgba(255,120,210,.42), transparent 58%),
      radial-gradient(900px 520px at 96% 6%, rgba(74,214,200,.30), transparent 55%),
      radial-gradient(1200px 800px at 50% 120%, rgba(21,10,54,.95), transparent 70%),
      linear-gradient(170deg, #7b4dff 0%, #6a3cf0 32%, #4a2bc7 60%, #2a1664 100%);
    background-attachment:fixed;
    display:flex; justify-content:center;
    padding:56px 18px 72px;
  }
  .wrap{width:100%; max-width:468px; display:flex; flex-direction:column; align-items:center}

  /* header */
  .avatar{width:104px;height:104px;border-radius:50%;object-fit:cover;
    border:3px solid rgba(255,255,255,.9); box-shadow:0 10px 36px rgba(0,0,0,.34)}
  .avatar--fallback{display:flex;align-items:center;justify-content:center;
    font-size:44px;font-weight:800;color:#5b2bd6;background:#fff}
  h1{font-size:25px;font-weight:800;letter-spacing:-.02em;margin:16px 0 0;text-align:center}
  .handle{margin:3px 0 0;color:var(--ink-soft);font-weight:600}
  .kind{display:inline-block;margin-top:10px;padding:4px 12px;border-radius:999px;
    background:var(--glass);border:1px solid var(--line);font-size:12px;font-weight:600;
    letter-spacing:.02em;color:var(--ink-soft);backdrop-filter:blur(6px)}
  .headline{margin:12px 6px 0;text-align:center;font-weight:600;font-size:16px}
  .bio{margin:10px 8px 0;text-align:center;color:var(--ink-soft);max-width:40ch}
  .chips{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin:16px 0 0}
  .chip{background:var(--glass);border:1px solid var(--line);padding:5px 12px;border-radius:999px;
    font-size:13px;font-weight:500;color:var(--ink);backdrop-filter:blur(6px)}

  /* button stack — the Linktree hallmark */
  .stack{width:100%;display:flex;flex-direction:column;gap:14px;margin:26px 0 0}
  .btn{display:flex;align-items:center;gap:12px;width:100%;
    padding:16px 16px;border-radius:var(--radius);
    background:var(--glass);border:1px solid var(--line);
    color:var(--ink);text-decoration:none;font-weight:600;
    backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
    box-shadow:0 6px 20px rgba(0,0,0,.14);
    transition:transform .14s ease, background .14s ease, box-shadow .14s ease}
  .btn:hover{transform:translateY(-2px);background:var(--glass-hi);box-shadow:0 12px 30px rgba(0,0,0,.24)}
  .btn:active{transform:translateY(0)}
  .btn-label{flex:1;text-align:center}
  .btn-ic{width:30px;height:30px;flex:0 0 30px;border-radius:9px;display:flex;align-items:center;
    justify-content:center;font-size:14px;font-weight:800;background:rgba(255,255,255,.18)}
  .btn-ic--ghost{background:transparent;color:var(--ink-dim);font-weight:600}

  .btn--primary{background:#ffffff;color:var(--accent);border-color:#fff;
    box-shadow:0 10px 30px rgba(0,0,0,.26)}
  .btn--primary:hover{background:#fff;transform:translateY(-2px);box-shadow:0 16px 40px rgba(0,0,0,.32)}
  .btn--primary .btn-ic{background:linear-gradient(135deg,#7b4dff,#4ad6c8);color:#fff}

  .section-label{align-self:flex-start;color:var(--ink-dim);font-size:11px;font-weight:700;
    text-transform:uppercase;letter-spacing:.1em;margin:26px 2px 0}

  /* share / connect card */
  .share{width:100%;margin:28px 0 0;padding:22px;border-radius:24px;
    background:var(--glass);border:1px solid var(--line);
    backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
    box-shadow:0 14px 40px rgba(0,0,0,.22);text-align:center}
  .share h2{margin:0;font-size:17px;font-weight:700}
  .share p{margin:6px 0 0;color:var(--ink-soft);font-size:13.5px}
  .qr{margin:18px auto 0;background:#fff;border-radius:18px;padding:14px;width:184px;height:184px;line-height:0}
  .qr svg{width:156px;height:156px}
  .code-row{display:flex;gap:8px;margin:16px 0 0}
  .code{flex:1;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;
    background:rgba(0,0,0,.22);border:1px solid var(--line);border-radius:12px;padding:12px;
    color:var(--ink);overflow:auto;white-space:nowrap;text-align:left}
  .copy{flex:0 0 auto;border:0;border-radius:12px;padding:0 18px;font-weight:700;cursor:pointer;
    color:#2b1769;background:#fff;transition:transform .12s ease}
  .copy:active{transform:translateY(1px)}
  .cmd{margin:12px 0 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;
    color:var(--ink-soft);background:rgba(0,0,0,.18);border:1px solid var(--line);border-radius:12px;
    padding:11px 12px;overflow:auto;text-align:left}
  .agentjson{display:inline-block;margin-top:14px;color:var(--ink-dim);font-size:12px;text-decoration:none}
  .agentjson:hover{color:var(--ink-soft)}

  .foot{margin:30px 0 0;text-align:center}
  .badge{display:inline-flex;align-items:center;gap:7px;padding:9px 15px;border-radius:999px;
    background:rgba(0,0,0,.22);border:1px solid var(--line);color:var(--ink);text-decoration:none;
    font-weight:700;font-size:13px;backdrop-filter:blur(8px)}
  .badge .spark{color:#4ad6c8}
  .share-url{display:block;margin-top:12px;color:var(--ink-dim);font-size:12px;word-break:break-all}

  #toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(20px);
    background:#fff;color:#1a1035;font-weight:700;font-size:13px;padding:10px 16px;border-radius:999px;
    box-shadow:0 10px 30px rgba(0,0,0,.3);opacity:0;pointer-events:none;transition:.22s}
  #toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
</style>
</head>
<body>
<main class="wrap">
  ${avatar}
  <h1>${name}</h1>
  ${handle ? `<p class="handle">${handle}</p>` : ''}
  ${kind}
  ${card.headline ? `<p class="headline">${esc(card.headline)}</p>` : ''}
  ${bio}
  ${skills ? `<div class="chips">${skills}</div>` : ''}

  <div class="stack">
    ${code ? `<button class="btn btn--primary" onclick="copyCode()">
      <span class="btn-ic">+</span>
      <span class="btn-label">Connect with this agent</span>
      <span class="btn-ic btn-ic--ghost" aria-hidden="true">›</span>
    </button>` : ''}
    ${links}
  </div>

  ${stack ? `<div class="section-label">Stack</div><div class="chips" style="align-self:stretch;justify-content:flex-start">${stack}</div>` : ''}

  <section class="share" id="share">
    <h2>Connect with this agent</h2>
    <p>Opening a channel sends one line to its owner. Messages flow only after they accept.</p>
    ${qrSvg ? `<div class="qr">${qrSvg}</div>` : ''}
    ${code ? `
    <div class="code-row">
      <div class="code" id="code">${code}</div>
      <button class="copy" onclick="copyCode()">Copy</button>
    </div>
    <div class="cmd">npx agent-card connect ${code} --note "hi"</div>` : ''}
    ${agentJsonUrl ? `<a class="agentjson" href="${esc(agentJsonUrl)}">machine-readable agent.json →</a>` : ''}
  </section>

  <div class="foot">
    <a class="badge" href="https://github.com/Terse-AI/agent-card" target="_blank" rel="noopener">
      <span class="spark">⚡</span> agent-card
    </a>
    ${shareUrl ? `<span class="share-url">${esc(shareUrl)}</span>` : ''}
  </div>
</main>
<div id="toast">Code copied</div>
<script>
  function toast(t){var e=document.getElementById('toast');if(!e)return;e.textContent=t;e.classList.add('show');clearTimeout(window.__tt);window.__tt=setTimeout(function(){e.classList.remove('show')},1600);}
  function copyCode(){
    var c=${JSON.stringify(code)};
    document.getElementById('share').scrollIntoView({behavior:'smooth',block:'center'});
    if(c&&navigator.clipboard){navigator.clipboard.writeText(c).then(function(){toast('Code copied — '+c);},function(){toast(c);});}
    else if(c){toast(c);}
  }
</script>
</body>
</html>`;
}

module.exports = { cardPage, esc };
