/**
 * Self-contained assets for the internal usage dashboard, served same-origin
 * by usage.ts so they satisfy the strict helmet CSP (no inline script/style).
 * The page asks for the staging password, exchanges it at /api/auth for a
 * staging-tier token, then renders data from the gated /api/usage endpoint.
 */

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>BLO — Usage</title>
  <link rel="stylesheet" href="/dashboard.css" />
</head>
<body>
  <main id="app">
    <header class="topbar">
      <h1>BLO Usage</h1>
      <div class="topbar-right">
        <span id="persistence" class="badge" hidden></span>
        <button id="refresh" hidden>Refresh</button>
      </div>
    </header>

    <section id="gate" class="card gate" hidden>
      <p>Enter the staging password to view usage.</p>
      <form id="gate-form">
        <input id="password" type="password" autocomplete="current-password" placeholder="Staging password" />
        <button type="submit">Unlock</button>
      </form>
      <p id="gate-error" class="error" hidden></p>
    </section>

    <section id="content" hidden>
      <div class="stat-row" id="stats"></div>

      <div class="card">
        <div class="card-head">
          <h2>Tokens per day</h2>
          <label class="days">
            Window
            <select id="days">
              <option value="7">7 days</option>
              <option value="14" selected>14 days</option>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
            </select>
          </label>
        </div>
        <div id="chart" class="chart"></div>
      </div>

      <div class="grid2">
        <div class="card">
          <h2>Top themes</h2>
          <ul id="themes" class="themes"></ul>
        </div>
        <div class="card">
          <h2>Recent requests</h2>
          <div class="table-wrap">
            <table id="recent">
              <thead><tr><th>Time</th><th>Path</th><th>Status</th><th>Tokens</th><th>ms</th><th>Tier</th></tr></thead>
              <tbody></tbody>
            </table>
          </div>
        </div>
      </div>
    </section>

    <p id="loading" class="muted" hidden>Loading…</p>
  </main>
  <script src="/dashboard.js"></script>
</body>
</html>`

export const DASHBOARD_CSS = `:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--fg:#1a1f24;--muted:#6b7280;--line:#e5e7eb;--accent:#2f6f4f;--accent2:#c98a1b;--err:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#0f1216;--card:#171b21;--fg:#e6e8eb;--muted:#9aa4b0;--line:#272d35;--accent:#4ca87a;--accent2:#e0a94a;--err:#f0776a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
#app{max-width:1000px;margin:0 auto;padding:20px}
.topbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
.topbar h1{font-size:20px;margin:0}
.topbar-right{display:flex;align-items:center;gap:10px}
.badge{font-size:12px;padding:3px 8px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}
.badge.mem{border-color:var(--accent2);color:var(--accent2)}
.badge.pg{border-color:var(--accent);color:var(--accent)}
button{font:inherit;cursor:pointer;border:1px solid var(--line);background:var(--card);color:var(--fg);padding:7px 12px;border-radius:8px}
button:hover{border-color:var(--muted)}
input,select{font:inherit;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:7px 10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:16px}
.card-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.card h2{font-size:14px;margin:0 0 10px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.gate{max-width:420px}
.gate form{display:flex;gap:8px}
.gate input{flex:1}
.error{color:var(--err)}
.muted{color:var(--muted)}
.stat-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.stat .n{font-size:24px;font-weight:650}
.stat .l{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em;margin-top:2px}
.chart{width:100%;overflow-x:auto}
.chart svg{display:block}
.bar rect{fill:var(--accent)}
.bar:hover rect{fill:var(--accent2)}
.axis{stroke:var(--line)}
.tick{fill:var(--muted);font-size:10px}
.themes{list-style:none;margin:0;padding:0}
.themes li{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line)}
.themes li:last-child{border-bottom:0}
.themes .c{color:var(--muted)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:720px){.grid2{grid-template-columns:1fr}}
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--muted);font-weight:600}
td.err{color:var(--err)}`

export const DASHBOARD_JS = String.raw`(function(){
  var TOKEN_KEY='blo_usage_token';
  var $=function(id){return document.getElementById(id);};
  function show(el,on){el.hidden=!on;}
  function fmt(n){return (n||0).toLocaleString();}
  function getToken(){try{return localStorage.getItem(TOKEN_KEY)||'';}catch(e){return '';}}
  function setToken(t){try{localStorage.setItem(TOKEN_KEY,t);}catch(e){}}
  function clearToken(){try{localStorage.removeItem(TOKEN_KEY);}catch(e){}}

  function svgEl(name,attrs){
    var el=document.createElementNS('http://www.w3.org/2000/svg',name);
    for(var k in attrs){el.setAttribute(k,attrs[k]);}
    return el;
  }

  function drawChart(daily){
    var wrap=$('chart'); wrap.textContent='';
    if(!daily.length){wrap.textContent='No data in this window yet.';return;}
    var W=Math.max(daily.length*46,320),H=200,pad=28,base=H-pad,top=10;
    var max=Math.max.apply(null,daily.map(function(d){return d.totalTokens;}))||1;
    var svg=svgEl('svg',{width:W,height:H,viewBox:'0 0 '+W+' '+H});
    svg.appendChild(svgEl('line',{'class':'axis',x1:pad,y1:base,x2:W,y2:base}));
    var bw=(W-pad-8)/daily.length;
    daily.forEach(function(d,i){
      var h=Math.round((base-top)*(d.totalTokens/max));
      var x=pad+i*bw+4, y=base-h;
      var g=svgEl('g',{'class':'bar'});
      var r=svgEl('rect',{x:x,y:y,width:Math.max(bw-8,3),height:Math.max(h,1),rx:3});
      var title=svgEl('title',{}); title.textContent=d.day+' — '+fmt(d.totalTokens)+' tokens, '+fmt(d.requests)+' req';
      r.appendChild(title); g.appendChild(r);
      if(i%Math.ceil(daily.length/8||1)===0){
        var t=svgEl('text',{'class':'tick',x:x,y:H-8}); t.textContent=d.day.slice(5); g.appendChild(t);
      }
      svg.appendChild(g);
    });
    var mx=svgEl('text',{'class':'tick',x:2,y:top+8}); mx.textContent=fmt(max); svg.appendChild(mx);
    wrap.appendChild(svg);
  }

  function renderStats(data){
    var t=data.today||{}, sum=(data.daily||[]).reduce(function(a,d){return a+d.totalTokens;},0);
    var reqs=(data.daily||[]).reduce(function(a,d){return a+d.requests;},0);
    var cells=[
      ['Today tokens', fmt(t.totalTokens)+' / '+fmt(t.totalBudget)],
      ['Today unique IPs', fmt(t.uniqueIps)],
      ['Window tokens', fmt(sum)],
      ['Window requests', fmt(reqs)]
    ];
    $('stats').innerHTML=cells.map(function(c){
      return '<div class="stat"><div class="n">'+c[1]+'</div><div class="l">'+c[0]+'</div></div>';
    }).join('');
  }

  function renderThemes(themes){
    var ul=$('themes');
    if(!themes.length){ul.innerHTML='<li class="muted">No themes yet</li>';return;}
    ul.innerHTML=themes.map(function(t){
      return '<li><span>'+t.theme+'</span><span class="c">'+fmt(t.count)+'</span></li>';
    }).join('');
  }

  function renderRecent(recent){
    var tb=$('recent').querySelector('tbody');
    tb.innerHTML=recent.map(function(r){
      var time=new Date(r.ts).toLocaleString();
      var cls=r.status>=400?' class="err"':'';
      return '<tr><td>'+time+'</td><td>'+r.path+'</td><td'+cls+'>'+r.status+'</td><td>'+fmt(r.totalTokens)+'</td><td>'+fmt(r.durationMs)+'</td><td>'+r.tier+'</td></tr>';
    }).join('');
  }

  function renderPersistence(mode){
    var b=$('persistence');
    b.hidden=false;
    b.className='badge '+(mode==='postgres'?'pg':'mem');
    b.textContent=mode==='postgres'?'Postgres · history on':'In-memory · since restart';
  }

  function load(){
    var token=getToken();
    if(!token){show($('gate'),true);return;}
    show($('gate'),false); show($('loading'),true);
    var days=$('days').value;
    fetch('/api/usage?days='+days,{headers:{Authorization:'Bearer '+token}})
      .then(function(res){
        if(res.status===401||res.status===403){clearToken();throw new Error('auth');}
        if(!res.ok){throw new Error('http '+res.status);}
        return res.json();
      })
      .then(function(data){
        show($('loading'),false); show($('content'),true);
        show($('refresh'),true);
        renderPersistence(data.persistence);
        renderStats(data); drawChart(data.daily||[]);
        renderThemes(data.themes||[]); renderRecent(data.recent||[]);
      })
      .catch(function(err){
        show($('loading'),false);
        if(err.message==='auth'){show($('content'),false);show($('gate'),true);}
        else{show($('content'),true);$('stats').innerHTML='<div class="stat"><div class="n">—</div><div class="l">Load failed: '+err.message+'</div></div>';}
      });
  }

  $('gate-form').addEventListener('submit',function(e){
    e.preventDefault();
    var pw=$('password').value; var errEl=$('gate-error'); show(errEl,false);
    fetch('/api/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw})})
      .then(function(res){return res.json().then(function(b){return {ok:res.ok,body:b};});})
      .then(function(r){
        if(!r.ok){errEl.textContent='Invalid password.';show(errEl,true);return;}
        if(r.body.tier!=='staging'){errEl.textContent='That password is not staging-tier.';show(errEl,true);return;}
        setToken(r.body.token); $('password').value=''; load();
      })
      .catch(function(){errEl.textContent='Network error.';show(errEl,true);});
  });

  $('refresh').addEventListener('click',load);
  $('days').addEventListener('change',load);
  load();
})();`
