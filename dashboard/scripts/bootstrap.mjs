// The full personal snapshot is persisted in private R2 storage. Embed only a
// useful summary fallback in Worker source so replay volume cannot inflate code.
export function thinBootstrap(snapshot) {
  const result=structuredClone(snapshot);
  function trim(value) {
    if(!value || typeof value!=='object')return;
    for(const [key,child] of Object.entries(value)) {
      if(Array.isArray(child)&&['windows','points','observations','samples','traces','body_frames','camera'].includes(key)) {
        value[key]=[];
        if(key==='windows'&&Object.hasOwn(value,'returned_windows'))value.returned_windows=0;
        value.bootstrap_series_omitted=true;
      }else trim(child);
    }
  }
  for(const match of result.matches??[]) {
    trim(match.analysis);
    for(const round of match.rounds??[]){trim(round.analysis);round.positions=[];}
    for(const player of match.players??[]){player.rounds=[];player.coverage={...player.coverage,bootstrap_rounds_omitted:true};}
    if(match.replay){match.replay.rounds=[];match.replay.coverage={...match.replay.coverage,observed_frames:0,bootstrap_series_omitted:true};}
  }
  result.coverage={...result.coverage,bootstrap_summary_only:true,detailed_series_source:'private_persisted_snapshot'};
  return result;
}
