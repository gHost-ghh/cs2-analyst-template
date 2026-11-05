/* Player exploration uses stable Steam IDs and shared match/round cohorts. */
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const fmt = (value, digits=0) => num(value) === null ? '—' : value.toLocaleString('zh-CN',{minimumFractionDigits:digits,maximumFractionDigits:digits});
const pct = value => num(value) === null ? '—' : `${fmt(value,1)}%`;
const div = (a,b,scale=1) => num(a)!==null && num(b)!==null && b>0 ? a/b*scale : null;
const flag = value => typeof value==='boolean' ? Number(value) : num(value);
const sum = (rows,key) => rows.length && rows.every(row=>flag(row[key])!==null) ? rows.reduce((n,row)=>n+flag(row[key]),0) : null;
const mapName = value => ({de_dust2:'Dust II',de_nuke:'Nuke',de_ancient:'Ancient',de_mirage:'Mirage',de_inferno:'Inferno',de_anubis:'Anubis',de_vertigo:'Vertigo',de_overpass:'Overpass',de_train:'Train'}[value] || String(value||'未知地图').replace(/^de_/,''));
const weaponName = value => ({ak47:'AK-47',m4a1:'M4A4',m4a1_silencer:'M4A1-S',awp:'AWP',ssg08:'SSG 08',deagle:'Desert Eagle',glock:'Glock-18',usp_silencer:'USP-S',hkp2000:'P2000',galilar:'Galil AR',famas:'FAMAS',hegrenade:'高爆手雷',inferno:'燃烧伤害',molotov:'燃烧瓶',incgrenade:'燃烧弹',flashbang:'闪光弹',smokegrenade:'烟雾弹'}[value]||value);
const relationLabel = value => ({self:'我',teammate:'队友',opponent:'对手',mixed:'同队 / 对阵'}[value]||'关系未知');
const dateFormat = new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
function date(value){const parsed=new Date(value||'');return Number.isNaN(parsed.getTime())?'日期未提供':dateFormat.format(parsed);}
function day(value){const parsed=new Date(value||'');return Number.isNaN(parsed.getTime())?null:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(parsed);}
const initial = name => [...String(name||'?').replace(/^765611\d+$/,'?')].slice(0,2).join('').toUpperCase();
const uid = player => String(player?.steamid ?? player?.steamid64 ?? '');
const buttonPlayer = (player,selected=false,extra='') => `<button type="button" class="pl-name-button${selected?' selected':''}" data-pl-player="${esc(uid(player))}" aria-pressed="${selected}" ${extra}><span class="pl-avatar${player?.is_self?' owner':''}" aria-hidden="true">${esc(initial(player?.name))}</span><span><strong>${esc(player?.name||uid(player)||'未知玩家')}</strong><small>${player?.is_self?'我的数据':esc(relationLabel(player?.relation))}</small></span>${player?.is_self?'<span class="pl-self-label">YOU</span>':''}</button>`;
const empty = (title,detail='') => `<div class="pl-empty"><span aria-hidden="true">⌑</span><strong>${esc(title)}</strong>${detail?`<p>${esc(detail)}</p>`:''}</div>`;

export function aggregatePlayerRounds(rows){
  const stats={rounds:rows.length};
  for(const key of ['kills','deaths','assists','damage','headshot_kills','shots','trade_kills','utility_damage','flash_enemy_seconds'])stats[key]=sum(rows,key);
  for(const [key,source]of Object.entries({kast_rounds:'kast',opening_kills:'opening_kill',opening_deaths:'opening_death',traded_rounds:'traded',survived_rounds:'survived',wins:'won'}))stats[key]=sum(rows,source);
  const damageRows=rows.filter(row=>num(row.damage)!==null),kastRows=rows.filter(row=>typeof row.kast==='boolean'),utilityRows=rows.filter(row=>num(row.utility_damage)!==null),shotRows=rows.filter(row=>num(row.shots)!==null),winRows=rows.filter(row=>typeof row.won==='boolean');
  stats.damage=sum(damageRows,'damage');stats.kast_rounds=sum(kastRows,'kast');stats.utility_damage=sum(utilityRows,'utility_damage');stats.shots=sum(shotRows,'shots');
  stats.wins=sum(winRows,'won');
  return {...stats,adr_rounds:damageRows.length,kast_observed_rounds:kastRows.length,utility_observed_rounds:utilityRows.length,shot_observed_rounds:shotRows.length,wins_observed_rounds:winRows.length,kd:div(stats.kills,stats.deaths),adr:div(stats.damage,damageRows.length),kast_pct:div(stats.kast_rounds,kastRows.length,100),headshot_pct:div(stats.headshot_kills,stats.kills,100),win_pct:div(stats.wins,winRows.length,100),utility_per_round:div(stats.utility_damage,utilityRows.length),opening_per_100:div(stats.opening_kills,stats.rounds,100)};
}

function fallbackPlayers(match,snapshot){
  const owner=String(snapshot.profile?.steamid64||snapshot.profile?.steamid||'');
  const roster=match.replay?.players||[];
  const ownerRounds=(match.rounds||[]).map(round=>({...round,shots:round.shots??round.aim?.firearm_shots??round.analysis?.aim?.firearm_shots??null,utility_damage:round.utility_damage??round.utility?.damage??round.analysis?.utility?.damage??null,flash_enemy_seconds:round.flash_enemy_seconds??round.utility?.enemy_blind_seconds??round.analysis?.utility?.enemy_blind_seconds??null,trade_kills:round.trade_kills??round.analysis?.trading?.trade_kills??null}));
  const list=roster.map(player=>({...player,steamid:uid(player),is_self:uid(player)===owner,relation:uid(player)===owner?'self':'unknown',rounds:uid(player)===owner?ownerRounds:[],summary:uid(player)===owner?match.summary:null,coverage:{source:'legacy_roster'}}));
  if(!list.some(player=>player.is_self)&&owner)list.unshift({steamid:owner,name:snapshot.profile?.name||'我',is_self:true,relation:'self',rounds:ownerRounds,summary:match.summary,coverage:{source:'legacy_roster'}});
  return list;
}
function scopedMatches(snapshot,scope){
  return (snapshot.matches||[]).filter(match=>(!scope.map||scope.map==='all'||match.map_name===scope.map)&&(!scope.since||(match.match_time_verified===true&&day(match.match_started_at)>=scope.since))).map(match=>({...match,players:Array.isArray(match.players)?match.players:fallbackPlayers(match,snapshot)}));
}
function playerRounds(player,side='all'){return (player?.rounds||[]).filter(round=>side==='all'||round.side===side);}
function normalizeState(data,state={}){
  const matches=scopedMatches(data,state),owner=String(data.profile?.steamid64||data.profile?.steamid||'');
  const match=matches.find(row=>row.match_id===state.matchId)||matches[0]||null;
  const allIds=new Set(matches.flatMap(row=>row.players.map(uid)));
  let steamid=allIds.has(String(state.steamid))?String(state.steamid):owner||uid(match?.players[0]);
  const tab=['match','directory','compare'].includes(state.tab)?state.tab:'match';
  if(tab==='match'&&!match?.players.some(player=>uid(player)===steamid))steamid=uid(match?.players.find(player=>player.is_self)||match?.players[0]);
  return {...state,tab,side:['all','CT','T'].includes(state.side)?state.side:'all',map:state.map||'all',search:String(state.search||''),relation:state.relation||'all',sort:state.sort||'matches',matchId:match?.match_id,steamid,compareIds:Array.isArray(state.compareIds)?[...new Set(state.compareIds.map(String))].slice(0,4):[],matches,match,owner};
}
function collectDirectory(state){
  const directory=new Map();
  for(const match of state.matches)for(const player of match.players){
    const steamid=uid(player);if(!steamid)continue;
    const rows=playerRounds(player,state.side),entry=directory.get(steamid)||{steamid,name:player.name||steamid,aliases:new Set(),is_self:steamid===state.owner,entries:[],rows:[],teammate_matches:0,opponent_matches:0};
    entry.name=entry.entries.length?entry.name:(player.name||steamid);
    for(const alias of [player.name,...(player.aliases||[])])if(alias)entry.aliases.add(alias);
    const teammate=rows.some(round=>round.relation==='teammate')||(state.side==='all'&&player.relation==='teammate');
    const opponent=rows.some(round=>round.relation==='opponent')||(state.side==='all'&&player.relation==='opponent');
    if(rows.length||state.side==='all')entry.entries.push({match,player,rows,teammate,opponent});
    if(teammate)entry.teammate_matches++;if(opponent)entry.opponent_matches++;
    entry.rows.push(...rows);directory.set(steamid,entry);
  }
  for(const entry of directory.values()){
    entry.shared_matches=entry.entries.length;entry.summary=aggregatePlayerRounds(entry.rows);
    entry.relation=entry.is_self?'self':entry.teammate_matches&&entry.opponent_matches?'mixed':entry.teammate_matches?'teammate':entry.opponent_matches?'opponent':'unknown';
    entry.aliases=[...entry.aliases];
  }
  return [...directory.values()].filter(player=>player.shared_matches>0);
}
function matchSummary(player,state){const rows=playerRounds(player,state.side);return rows.length?aggregatePlayerRounds(rows):(state.side==='all'?player?.summary:null)||aggregatePlayerRounds([]);}
function weaponRows(entries){
  const map=new Map();
  for(const {rows}of entries)for(const round of rows)for(const [weapon,stats]of Object.entries(round.by_weapon||{})){
    const out=map.get(weapon)||{weapon,kills:0,headshot_kills:0,damage:0,shots:0,known:{kills:true,headshot_kills:true,damage:true,shots:true}};
    for(const key of ['kills','headshot_kills','damage','shots']){if(num(stats[key])===null)out.known[key]=false;else out[key]+=stats[key];}
    map.set(weapon,out);
  }
  // Legacy owner round records do not contain per-weapon details. Match summaries remain usable for an unfiltered full match.
  if(!map.size)for(const entry of entries){
    if(entry.rows.length!==(entry.player.rounds||[]).length)continue;
    for(const [weapon,stats]of Object.entries(entry.player.by_weapon||entry.player.summary?.by_weapon||{})){
      const out=map.get(weapon)||{weapon,kills:0,headshot_kills:0,damage:0,shots:0,known:{kills:true,headshot_kills:true,damage:true,shots:true}};
      for(const key of ['kills','headshot_kills','damage','shots']){if(num(stats[key])===null)out.known[key]=false;else out[key]+=stats[key];}map.set(weapon,out);
    }
  }
  return [...map.values()].map(row=>({...row,...Object.fromEntries(Object.entries(row.known).map(([key,known])=>[key,known?row[key]:null]))})).sort((a,b)=>(b.kills??-1)-(a.kills??-1)||(b.damage??-1)-(a.damage??-1));
}
function sharedComparison(entry,state,teammatesOnly=false){
  const playerRowsList=[],ownerRows=[],pairs=[];let matches=0;
  for(const {match,player,rows}of entry.entries){
    const own=match.players.find(row=>uid(row)===state.owner);if(!own)continue;
    const ownMap=new Map((own.rounds||[]).map(round=>[round.round_number,round]));
    let count=0;
    for(const round of rows){
      if(teammatesOnly&&round.relation!=='teammate')continue;
      const ownRound=ownMap.get(round.round_number);if(!ownRound)continue;
      playerRowsList.push(round);ownerRows.push(ownRound);pairs.push([round,ownRound]);count++;
    }
    if(count)matches++;
  }
  const player=aggregatePlayerRounds(playerRowsList),owner=aggregatePlayerRounds(ownerRows),coverage={};
  const observed=(keys)=>pairs.filter(pair=>pair.every(round=>keys.every(key=>flag(round[key])!==null)));
  for(const [name,keys,fields]of [
    ['adr',['damage'],['damage','adr','adr_rounds']],
    ['kd',['kills','deaths'],['kd']],
    ['kast',['kast'],['kast_rounds','kast_pct','kast_observed_rounds']],
    ['headshot',['headshot_kills','kills'],['headshot_pct']],
    ['utility',['utility_damage'],['utility_damage','utility_per_round','utility_observed_rounds']],
    ['opening',['opening_kill'],['opening_per_100']]
  ]){
    const subset=observed(keys);coverage[`${name}_rounds`]=subset.length;
    const a=aggregatePlayerRounds(subset.map(pair=>pair[0])),b=aggregatePlayerRounds(subset.map(pair=>pair[1]));
    for(const key of fields){player[key]=a[key];owner[key]=b[key];}
  }
  return {steamid:entry.steamid,name:entry.name,matches,rounds:playerRowsList.length,coverage,player,owner,player_rows:playerRowsList,owner_rows:ownerRows};
}
function metric(label,value,unit='',detail=''){return `<div class="pl-metric"><span>${esc(label)}</span><strong>${value}${unit?`<small>${esc(unit)}</small>`:''}</strong>${detail?`<small>${esc(detail)}</small>`:''}</div>`;}
function summaryMetrics(stats){return `<div class="pl-stat-grid">${metric('K / D / A',`${fmt(stats.kills)}<i>/</i>${fmt(stats.deaths)}<i>/</i>${fmt(stats.assists)}`)}${metric('ADR',fmt(stats.adr,1),'',`${fmt(stats.damage)} ${stats.adr_rounds<stats.rounds?'已记录伤害':'总伤害'}`)}${metric('KAST',pct(stats.kast_pct),'',`${fmt(stats.kast_rounds)} / ${fmt(stats.kast_observed_rounds??stats.rounds)} 回合`)}${metric('爆头率',pct(stats.headshot_pct),'',`${fmt(stats.headshot_kills)} 爆头击杀`)}</div>`;}
function utilityBlock(stats){return `<div class="pl-utility-grid">${metric('道具伤害',fmt(stats.utility_damage),'HP')}${metric('致盲对手',fmt(stats.flash_enemy_seconds,1),'s')}${metric('补枪击杀',fmt(stats.trade_kills))}${metric('首杀 / 首死',`${fmt(stats.opening_kills)}<i>/</i>${fmt(stats.opening_deaths)}`)}</div>`;}
function coverageLine(player,rows){
  const total=rows.length,damage=rows.filter(row=>num(row.damage)!==null).length,shots=rows.filter(row=>num(row.shots)!==null).length;
  const incomplete=damage<total||shots<total||!total;
  return `<div class="pl-coverage${incomplete?' incomplete':''}"><span class="pl-dot"></span>${total?`伤害 ${damage}/${total} 回合<span>·</span>射击 ${shots}/${total} 回合`:'该场尚未提供逐回合数据'}${player.coverage?.source==='legacy_replay'||player.coverage?.source==='legacy_roster'?'<span>·</span>历史解析':''}</div>`;
}
function weaponsTable(entries){
  const rows=weaponRows(entries);
  return rows.length?`<div class="pl-table-scroll" tabindex="0" role="region" aria-label="武器表现，可横向滚动"><table class="pl-table pl-weapons"><caption class="sr-only">武器表现</caption><thead><tr><th scope="col">武器</th><th scope="col">击杀</th><th scope="col">伤害</th><th scope="col">爆头率</th><th scope="col">射击</th></tr></thead><tbody>${rows.map(row=>`<tr><th scope="row">${esc(weaponName(row.weapon))}</th><td>${fmt(row.kills)}</td><td>${fmt(row.damage)}</td><td>${pct(div(row.headshot_kills,row.kills,100))}</td><td>${fmt(row.shots)}</td></tr>`).join('')}</tbody></table></div>`:empty('暂无武器明细');
}
function roundChart(rows){
  if(!rows.length)return '';
  const max=Math.max(200,...rows.map(row=>num(row.damage)||0));
  return `<div class="pl-round-chart" role="group" aria-label="逐回合伤害与击杀">${rows.map(round=>`<button type="button" data-pl-round="${round.round_number}" title="R${round.round_number} · ${esc(round.side||'未知阵营')} · ${fmt(round.damage)} 伤害 · ${fmt(round.kills)} 击杀" class="pl-round-bar ${round.side==='CT'?'ct':'t'}${round.won===true?' won':''}"><span class="pl-round-kills">${num(round.kills)>0?`${round.kills}K`:''}</span><span class="pl-round-track">${num(round.damage)!==null?`<i style="height:${Math.max(2,round.damage/max*100)}%"></i>`:'<b>—</b>'}</span><small>${round.round_number}</small></button>`).join('')}</div><div class="pl-chart-legend"><span><i class="ct"></i>CT 伤害</span><span><i class="t"></i>T 伤害</span><span>点击回合查看雷达</span></div>`;
}
function roundsTable(rows){
  return rows.length?`<details class="pl-round-details"><summary>逐回合明细 <span>${rows.length} 回合</span></summary><div class="pl-table-scroll" tabindex="0" role="region" aria-label="逐回合明细，可横向滚动"><table class="pl-table"><caption class="sr-only">玩家逐回合数据</caption><thead><tr><th scope="col">回合</th><th scope="col">阵营</th><th scope="col">结果</th><th scope="col">K / D / A</th><th scope="col">伤害</th><th scope="col">KAST</th><th scope="col">首杀</th><th scope="col">补枪</th><th scope="col">道具伤害</th><th scope="col">致盲</th></tr></thead><tbody>${rows.map(round=>`<tr><th scope="row"><button type="button" class="pl-text-button" data-pl-round="${round.round_number}">R${round.round_number} ↗</button></th><td><span class="pl-side ${round.side==='CT'?'ct':'t'}">${esc(round.side||'—')}</span></td><td class="${round.won===true?'pl-positive':round.won===false?'pl-negative':''}">${round.won===true?'胜':round.won===false?'负':'—'}</td><td>${fmt(round.kills)} / ${fmt(round.deaths)} / ${fmt(round.assists)}</td><td>${fmt(round.damage)}</td><td>${round.kast===true?'✓':round.kast===false?'−':'—'}</td><td>${round.opening_kill===true?'✓':round.opening_kill===false?'−':'—'}</td><td>${fmt(round.trade_kills)}</td><td>${fmt(round.utility_damage)}</td><td>${num(round.flash_enemy_seconds)!==null?`${fmt(round.flash_enemy_seconds,1)}s`:'—'}</td></tr>`).join('')}</tbody></table></div></details>`:'';
}
function playerHeader(player,subtitle=''){
  return `<div class="pl-profile-header"><span class="pl-avatar large${player.is_self?' owner':''}" aria-hidden="true">${esc(initial(player.name))}</span><div><div class="pl-eyebrow">PLAYER PROFILE${player.is_self?' / YOU':''}</div><h2>${esc(player.name||uid(player))}</h2><p>${esc(subtitle||relationLabel(player.relation))}</p></div><span class="pl-steamid" title="Steam ID">${esc(uid(player))}</span></div>`;
}
function scoreboard(state){
  const match=state.match;if(!match)return empty('当前筛选下没有对局');
  const selected=match.players.find(player=>uid(player)===state.steamid)||match.players.find(player=>player.is_self)||match.players[0];
  const sorted=match.players.map(player=>({player,stats:matchSummary(player,state)})).sort((a,b)=>(b.stats.kills??-1)-(a.stats.kills??-1)||(b.stats.damage??-1)-(a.stats.damage??-1));
  const sections=[['我方',sorted.filter(row=>row.player.is_self||row.player.relation==='teammate'),'own'],['对方',sorted.filter(row=>!row.player.is_self&&row.player.relation==='opponent'),'opponents'],['其他玩家',sorted.filter(row=>!row.player.is_self&&!['teammate','opponent'].includes(row.player.relation)),'unknown']].filter(([,rows])=>rows.length);
  const maxADR=Math.max(100,...sorted.map(row=>row.stats.adr||0));
  const table=`<div class="pl-table-scroll" tabindex="0" role="region" aria-label="全员比分板，可横向滚动"><table class="pl-table pl-scoreboard"><caption class="sr-only">${esc(mapName(match.map_name))} 全员比分板</caption><thead><tr><th scope="col">玩家</th><th scope="col">K / D / A</th><th scope="col">K/D</th><th scope="col">ADR</th><th scope="col">KAST</th><th scope="col">爆头率</th><th scope="col">首杀 / 首死</th><th scope="col">道具伤害</th></tr></thead>${sections.map(([name,rows,key])=>`<tbody class="pl-team-group ${key}"><tr class="pl-team-heading"><th colspan="8" scope="colgroup"><span>${name}</span><small>${rows.length} 名玩家</small></th></tr>${rows.map(({player,stats})=>`<tr class="pl-score-row${uid(player)===uid(selected)?' selected':''}${player.is_self?' is-owner':''}"><th scope="row">${buttonPlayer(player,uid(player)===uid(selected))}</th><td class="pl-kda">${fmt(stats.kills)}<i>/</i>${fmt(stats.deaths)}<i>/</i>${fmt(stats.assists)}</td><td>${fmt(stats.kd,2)}</td><td><div class="pl-adr-cell"><strong>${fmt(stats.adr,1)}</strong>${num(stats.adr)!==null?`<i style="width:${Math.max(0,Math.min(100,stats.adr/maxADR*100))}%"></i>`:''}</div></td><td>${pct(stats.kast_pct)}</td><td>${pct(stats.headshot_pct)}</td><td>${fmt(stats.opening_kills)} / ${fmt(stats.opening_deaths)}</td><td>${fmt(stats.utility_damage)}</td></tr>`).join('')}</tbody>`).join('')}</table></div>`;
  const rows=playerRounds(selected,state.side),stats=matchSummary(selected,state);
  return `<div class="pl-match-toolbar"><label><span>当前对局</span><select data-pl-control="matchId" aria-label="选择全员数据对局">${state.matches.map(row=>`<option value="${esc(row.match_id)}" ${row.match_id===match.match_id?'selected':''}>${esc(mapName(row.map_name))} · ${esc(date(row.match_started_at))}</option>`).join('')}</select></label><span class="pl-scope-pill">${match.players.length} 名玩家 · ${rows.length||match.rounds?.length||0} 回合</span></div><section class="pl-card pl-score-card"><div class="pl-card-title"><h2>全员比分板</h2><span>${esc(mapName(match.map_name))}<i>·</i>${esc(date(match.match_started_at))}</span><button type="button" class="pl-text-button" data-pl-replay="${esc(match.match_id)}">战术回放 ↗</button></div>${table}</section>${selected?`<section class="pl-card pl-selected-player">${playerHeader(selected,`${mapName(match.map_name)} · ${date(match.match_started_at)} · ${relationLabel(selected.relation)}`)}${summaryMetrics(stats)}${coverageLine(selected,rows)}<div class="pl-detail-grid"><section><div class="pl-card-title"><h3>回合表现</h3><span>伤害 / 击杀</span></div>${rows.length?roundChart(rows):empty('暂无逐回合明细')}</section><section><div class="pl-card-title"><h3>道具与团队贡献</h3></div>${utilityBlock(stats)}<button type="button" class="pl-profile-link" data-pl-open-profile="${esc(uid(selected))}">查看玩家跨局档案 <span>→</span></button></section></div>${roundsTable(rows)}<div class="pl-weapons-section"><div class="pl-card-title"><h3>武器表现</h3></div>${weaponsTable([{match,player:selected,rows}])}</div></section>`:''}`;
}
function trendChart(entry){
  const rows=entry.entries.filter(item=>num(aggregatePlayerRounds(item.rows).adr)!==null).slice().sort((a,b)=>(Date.parse(a.match.match_started_at)||0)-(Date.parse(b.match.match_started_at)||0));
  if(!rows.length)return empty('暂无伤害趋势');
  const width=640,height=145,pad=25,max=Math.max(150,...rows.map(row=>aggregatePlayerRounds(row.rows).adr)),step=rows.length>1?(width-pad*2)/(rows.length-1):0;
  const points=rows.map((row,index)=>({x:rows.length>1?pad+index*step:width/2,y:height-pad-aggregatePlayerRounds(row.rows).adr/max*(height-pad*2),row,value:aggregatePlayerRounds(row.rows).adr}));
  return `<div class="pl-trend"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="共同对局 ADR 趋势"><defs><linearGradient id="pl-trend-gradient" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#57dbc6" stop-opacity=".22"/><stop offset="100%" stop-color="#57dbc6" stop-opacity="0"/></linearGradient></defs>${[0,.5,1].map(v=>`<line x1="${pad}" x2="${width-pad}" y1="${height-pad-v*(height-pad*2)}" y2="${height-pad-v*(height-pad*2)}" stroke="#253747" stroke-dasharray="3 5"/><text x="${width-pad}" y="${height-pad-v*(height-pad*2)-5}" text-anchor="end" fill="#637f94" font-size="9">${fmt(v*max)}</text>`).join('')}${points.length>1?`<path d="M${points[0].x},${height-pad} ${points.map(point=>`L${point.x},${point.y}`).join(' ')} L${points.at(-1).x},${height-pad}Z" fill="url(#pl-trend-gradient)"/><polyline points="${points.map(point=>`${point.x},${point.y}`).join(' ')}" fill="none" stroke="#65c9ba" stroke-width="2"/>`:''}${points.map(point=>`<g><title>${esc(mapName(point.row.match.map_name))} · ${esc(date(point.row.match.match_started_at))} · ADR ${fmt(point.value,1)}</title><circle cx="${point.x}" cy="${point.y}" r="4" fill="#8ae5d3" stroke="#12251f" stroke-width="3"/></g>`).join('')}</svg><div class="pl-chart-legend"><span><i class="owner"></i>ADR</span><span>按比赛时间排列</span></div></div>`;
}
function mapBreakdown(entry){
  const maps=new Map();for(const item of entry.entries){const rows=maps.get(item.match.map_name)||[];rows.push(...item.rows);maps.set(item.match.map_name,rows);}
  return `<div class="pl-map-breakdown">${[...maps].map(([name,rows])=>{const stats=aggregatePlayerRounds(rows);return `<div><strong>${esc(mapName(name))}</strong><span>${rows.length} 回合</span><b>${fmt(stats.adr,1)} <small>ADR</small></b><i style="--pl-map-value:${num(stats.adr)!==null?Math.min(100,stats.adr/200*100):0}%"></i></div>`;}).join('')}</div>`;
}
function sharedMatchesTable(entry,state){
  return `<div class="pl-table-scroll" tabindex="0" role="region" aria-label="共同对局，可横向滚动"><table class="pl-table pl-history"><caption class="sr-only">与我的共同对局</caption><thead><tr><th scope="col">对局</th><th scope="col">关系</th><th scope="col">回合</th><th scope="col">K / D / A</th><th scope="col">ADR</th><th scope="col">KAST</th><th scope="col">爆头率</th></tr></thead><tbody>${entry.entries.map(item=>{const stats=aggregatePlayerRounds(item.rows);return `<tr><th scope="row"><button type="button" class="pl-match-link" data-pl-history="${esc(item.match.match_id)}"><strong>${esc(mapName(item.match.map_name))}</strong><small>${esc(date(item.match.match_started_at))}</small></button></th><td><span class="pl-relation ${esc(item.player.relation)}">${esc(relationLabel(item.player.relation))}</span></td><td>${fmt(stats.rounds)}</td><td>${fmt(stats.kills)} / ${fmt(stats.deaths)} / ${fmt(stats.assists)}</td><td>${fmt(stats.adr,1)}</td><td>${pct(stats.kast_pct)}</td><td>${pct(stats.headshot_pct)}</td></tr>`;}).join('')}</tbody></table></div>`;
}
function compareBars(comparison){
  const specs=[['ADR','adr',1,'','adr'],['K/D','kd',2,'','kd'],['KAST','kast_pct',1,'%','kast'],['爆头率','headshot_pct',1,'%','headshot'],['道具伤害 / 回合','utility_per_round',1,'','utility'],['首杀 / 100 回合','opening_per_100',1,'','opening']];
  return `<div class="pl-compare-bars">${specs.map(([name,key,digits,unit,coverage])=>{const a=comparison.player[key],b=comparison.owner[key],max=Math.max(1,a||0,b||0),observed=comparison.coverage?.[`${coverage}_rounds`]??comparison.rounds;return `<div class="pl-compare-metric"><div><span title="双方均有记录的 ${observed} 个共同回合">${name}${observed<comparison.rounds?`<small> · ${observed} 回合</small>`:''}</span><strong>${fmt(a,digits)}${num(a)!==null?unit:''}<i>/</i><b>${fmt(b,digits)}${num(b)!==null?unit:''}</b></strong></div><div class="pl-pair-bars"><i class="peer" style="width:${num(a)===null?0:a/max*100}%"></i><i class="owner" style="width:${num(b)===null?0:b/max*100}%"></i></div></div>`;}).join('')}</div>`;
}
function filterDirectory(state,directory){
  const query=state.search.toLocaleLowerCase();
  return directory.filter(entry=>(state.relation==='all'||entry.relation===state.relation||entry.relation==='mixed'&&['teammate','opponent'].includes(state.relation))&&(!query||[entry.name,entry.steamid,...entry.aliases].some(name=>String(name).toLocaleLowerCase().includes(query)))).sort((a,b)=>state.sort==='adr'?(b.summary.adr??-1)-(a.summary.adr??-1)||b.shared_matches-a.shared_matches:b.shared_matches-a.shared_matches||(b.summary.kills??-1)-(a.summary.kills??-1));
}
function directoryView(state,directory){
  const visible=filterDirectory(state,directory),selected=visible.find(entry=>entry.steamid===state.steamid)||visible[0];
  const comparison=selected&&!selected.is_self?sharedComparison(selected,state):null;
  return `<div class="pl-directory-layout"><aside class="pl-card pl-directory-sidebar"><div class="pl-directory-tools"><label class="pl-search"><span aria-hidden="true">⌕</span><input type="search" placeholder="搜索名字或 Steam ID" value="${esc(state.search)}" data-pl-search aria-label="搜索玩家"></label><div><select data-pl-control="relation" aria-label="筛选玩家关系"><option value="all" ${state.relation==='all'?'selected':''}>所有玩家</option><option value="teammate" ${state.relation==='teammate'?'selected':''}>曾经同队</option><option value="opponent" ${state.relation==='opponent'?'selected':''}>曾经对阵</option></select><select data-pl-control="sort" aria-label="玩家排序"><option value="matches" ${state.sort==='matches'?'selected':''}>共同场次</option><option value="adr" ${state.sort==='adr'?'selected':''}>ADR</option></select></div></div><div class="pl-directory-count">${visible.length} 名玩家</div><div class="pl-directory-list">${visible.length?visible.map(entry=>`<div class="pl-directory-entry${entry.steamid===selected?.steamid?' active':''}">${buttonPlayer(entry,entry.steamid===selected?.steamid)}<span><b>${entry.shared_matches}</b> 场<small>${fmt(entry.summary.adr,1)} ADR</small></span></div>`).join(''):empty('没有匹配的玩家')}</div></aside><div class="pl-directory-main">${selected?`<section class="pl-card">${playerHeader(selected,`${selected.shared_matches} 场共同对局 · ${selected.summary.rounds} 回合`)}${summaryMetrics(selected.summary)}<div class="pl-encounter-strip"><span>同队 <b>${selected.teammate_matches}</b> 场</span><span>对阵 <b>${selected.opponent_matches}</b> 场</span><span>对局胜率 <b>${pct(selected.summary.win_pct)}</b></span></div>${selected.aliases.length>1?`<div class="pl-aliases">曾用名 ${selected.aliases.filter(name=>name!==selected.name).map(esc).join(' · ')}</div>`:''}<div class="pl-detail-grid"><section><div class="pl-card-title"><h3>共同对局趋势</h3></div>${trendChart(selected)}</section><section><div class="pl-card-title"><h3>地图表现</h3></div>${mapBreakdown(selected)}</section></div></section>${comparison?.rounds?`<section class="pl-card"><div class="pl-card-title"><h3>与我对比</h3><span>${comparison.matches} 场 · ${comparison.rounds} 共同回合</span></div><div class="pl-chart-legend pl-compare-legend"><span><i class="peer"></i>${esc(selected.name)}</span><span><i class="owner"></i>我</span></div>${compareBars(comparison)}</section>`:''}<section class="pl-card pl-history-card"><div class="pl-card-title"><h3>共同对局</h3><span>${selected.shared_matches} 场</span></div>${sharedMatchesTable(selected,state)}</section><section class="pl-card"><div class="pl-card-title"><h3>武器与团队贡献</h3></div>${utilityBlock(selected.summary)}${weaponsTable(selected.entries)}</section>`:empty('选择一名玩家')}</div></div>`;
}
function frequentTeammates(directory){return directory.filter(entry=>!entry.is_self&&entry.teammate_matches>=2).sort((a,b)=>b.teammate_matches-a.teammate_matches||b.shared_matches-a.shared_matches);}
function comparisonSelection(state,teammates){
  const selected=state.compareIds.filter(id=>teammates.some(player=>player.steamid===id));
  return selected.length?selected:teammates.slice(0,3).map(player=>player.steamid);
}
function compareView(state,directory){
  const teammates=frequentTeammates(directory);
  if(!teammates.length)return `<section class="pl-card">${empty('尚无重复同队的玩家','同一名队友完成至少 2 场共同对局后，将在这里显示。')}</section>`;
  const selectedIds=comparisonSelection(state,teammates);
  const comparisons=teammates.filter(player=>selectedIds.includes(player.steamid)).map(player=>({entry:player,comparison:sharedComparison(player,state,true)}));
  return `<section class="pl-card pl-teammate-picker"><div class="pl-card-title"><h2>常玩队友</h2><span>至少 2 场同队 · 最多同时比较 4 人</span></div><div class="pl-teammate-options">${teammates.map(player=>`<button type="button" class="pl-teammate-chip${selectedIds.includes(player.steamid)?' selected':''}" data-pl-compare="${esc(player.steamid)}" aria-pressed="${selectedIds.includes(player.steamid)}"><span class="pl-avatar" aria-hidden="true">${esc(initial(player.name))}</span><span><strong>${esc(player.name)}</strong><small>${player.teammate_matches} 场同队</small></span><i aria-hidden="true">${selectedIds.includes(player.steamid)?'✓':'+'}</i></button>`).join('')}</div></section><div class="pl-compare-summary"><span>共同回合对比</span><p>双方仅统计共同出场的同队回合。</p><div class="pl-chart-legend"><span><i class="peer"></i>队友</span><span><i class="owner"></i>我</span></div></div><div class="pl-comparison-grid">${comparisons.map(({entry,comparison})=>`<section class="pl-card pl-comparison-card"><div class="pl-comparison-header">${buttonPlayer(entry)}<span>${comparison.matches} 场<b>${comparison.rounds} 回合</b></span></div>${comparison.rounds?compareBars(comparison):empty('暂无可对齐的回合')}<div class="pl-comparison-bottom"><span>总击杀 <b>${fmt(comparison.player.kills)}</b><i>/</i>${fmt(comparison.owner.kills)}</span><span>总伤害 <b>${fmt(comparison.player.damage)}</b><i>/</i>${fmt(comparison.owner.damage)}</span></div><button type="button" class="pl-profile-link" data-pl-open-profile="${esc(entry.steamid)}">查看玩家档案 <span>→</span></button></section>`).join('')}</div>`;
}

export function getPlayersViewModel(snapshot,state={}){
  const normalized=normalizeState(snapshot||{},state),directory=collectDirectory(normalized);
  const visible=filterDirectory(normalized,directory),selected=normalized.tab==='directory'?(visible.find(entry=>entry.steamid===normalized.steamid)||visible[0])?.steamid:normalized.steamid;
  const teammates=frequentTeammates(directory),selectedIds=comparisonSelection(normalized,teammates);
  return {scope:{map:normalized.map,side:normalized.side,since:normalized.since||null,tab:normalized.tab,search:normalized.search,relation:normalized.relation},owner_steamid:normalized.owner,selected_match_id:normalized.matchId,selected_steamid:selected||null,selected_comparison_steamids:selectedIds,selected_comparisons:teammates.filter(entry=>selectedIds.includes(entry.steamid)).map(entry=>sharedComparison(entry,normalized,true)),players:directory.map(entry=>({steamid:entry.steamid,name:entry.name,is_self:entry.is_self,shared_matches:entry.shared_matches,teammate_matches:entry.teammate_matches,opponent_matches:entry.opponent_matches,summary:entry.summary,match_ids:entry.entries.map(item=>item.match.match_id),comparison:entry.is_self?null:sharedComparison(entry,normalized)}))};
}
export function renderPlayers(snapshot,state={}){
  const s=normalizeState(snapshot||{},state),directory=collectDirectory(s),repeated=directory.filter(player=>!player.is_self&&player.shared_matches>=2),teammates=directory.filter(player=>!player.is_self&&player.teammate_matches>=2);
  if(!s.matches.length)return `<div class="pl-workspace">${empty('当前筛选下没有对局','调整地图、阵营或起始日期。')}</div>`;
  return `<div class="pl-workspace" data-players-view><div class="pl-workspace-top"><div class="pl-view-tabs" role="tablist" aria-label="玩家分析视图">${[['match','当局数据'],['directory','玩家档案'],['compare','常玩对比']].map(([key,name])=>`<button type="button" role="tab" id="pl-tab-${key}" aria-selected="${s.tab===key}" aria-controls="pl-panel" data-pl-tab="${key}" tabindex="${s.tab===key?'0':'-1'}">${name}${key==='compare'&&teammates.length?`<small>${teammates.length}</small>`:''}</button>`).join('')}</div><div class="pl-workspace-scope"><span>${s.matches.length} 场</span><i>·</i><span>${directory.length} 人</span>${s.side!=='all'?`<i>·</i><span>${s.side}</span>`:''}</div></div><div class="pl-collection-stats"><span>遇到的玩家 <b>${directory.filter(player=>!player.is_self).length}</b></span><span>重复出现 <b>${repeated.length}</b></span><span>常玩队友 <b>${teammates.length}</b></span></div><div id="pl-panel" role="tabpanel" aria-labelledby="pl-tab-${s.tab}">${s.tab==='match'?scoreboard(s):s.tab==='directory'?directoryView(s,directory):compareView(s,directory)}</div></div>`;
}

export function mountPlayers(container,{onReplay,onMatch,onStateChange}={}){
  let snapshot={},state={tab:'match',map:'all',side:'all',since:'',compareIds:[]},destroyed=false;
  const draw=({focusSelector,selection}={})=>{
    if(destroyed)return;
    const normalized=normalizeState(snapshot,state);state={...state,matchId:normalized.matchId,steamid:normalized.steamid};
    if(state.tab==='directory'){
      const visible=filterDirectory(normalized,collectDirectory(normalized));state.steamid=(visible.find(entry=>entry.steamid===state.steamid)||visible[0])?.steamid||'';
    }
    container.innerHTML=renderPlayers(snapshot,state);
    if(focusSelector){const node=container.querySelector(focusSelector);node?.focus({preventScroll:true});if(selection&&node?.setSelectionRange)node.setSelectionRange(...selection);}
    onStateChange?.({...state});
  };
  const click=event=>{
    const button=event.target.closest('button');if(!button||!container.contains(button))return;
    if(button.dataset.plTab){state.tab=button.dataset.plTab;draw({focusSelector:`[data-pl-tab="${state.tab}"]`});return;}
    if(button.dataset.plPlayer){state.steamid=button.dataset.plPlayer;if(state.tab==='compare')state.tab='directory';draw();return;}
    if(button.dataset.plOpenProfile){state.steamid=button.dataset.plOpenProfile;state.tab='directory';draw();return;}
    if(button.dataset.plHistory){state.matchId=button.dataset.plHistory;state.tab='match';draw();onMatch?.(state.matchId,state.steamid);return;}
    if(button.dataset.plReplay){onReplay?.({matchId:button.dataset.plReplay,steamid:state.steamid});return;}
    if(button.dataset.plRound){onReplay?.({matchId:state.matchId,roundNumber:Number(button.dataset.plRound),steamid:state.steamid});return;}
    if(button.dataset.plCompare){
      const normalized=normalizeState(snapshot,state),candidates=frequentTeammates(collectDirectory(normalized));
      let ids=comparisonSelection(normalized,candidates);
      const id=button.dataset.plCompare;if(ids.includes(id)){if(ids.length>1)ids=ids.filter(value=>value!==id);}else if(ids.length<4)ids.push(id);
      state.compareIds=ids;draw({focusSelector:`[data-pl-compare="${id}"]`});
    }
  };
  const change=event=>{const control=event.target.dataset.plControl;if(!control)return;state[control]=event.target.value;draw();};
  const input=event=>{if(!event.target.matches('[data-pl-search]'))return;state.search=event.target.value;draw({focusSelector:'[data-pl-search]',selection:[event.target.selectionStart,event.target.selectionEnd]});};
  const keydown=event=>{
    if(!event.target.matches('[data-pl-tab]')||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    const tabs=['match','directory','compare'],index=tabs.indexOf(state.tab);state.tab=event.key==='Home'?tabs[0]:event.key==='End'?tabs.at(-1):tabs[(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length];event.preventDefault();draw({focusSelector:`[data-pl-tab="${state.tab}"]`});
  };
  container.addEventListener('click',click);container.addEventListener('change',change);container.addEventListener('input',input);container.addEventListener('keydown',keydown);
  return {
    update(data,scope={}){snapshot=data||{};const changedMatch=scope.matchId&&scope.matchId!==state.matchId;state={...state,...scope,...(changedMatch?{matchId:scope.matchId}:{})};draw();},
    selectPlayer(steamid,matchId){state.steamid=String(steamid);if(matchId){state.matchId=matchId;state.tab='match';}else state.tab='directory';draw();},
    getContext(){return getPlayersViewModel(snapshot,state);},
    destroy(){destroyed=true;container.removeEventListener('click',click);container.removeEventListener('change',change);container.removeEventListener('input',input);container.removeEventListener('keydown',keydown);}
  };
}
