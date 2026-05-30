import { newGame, G } from "../src/core/state.js";
import { tick } from "../src/sim/possession.js";
import { loadLeagueFromDir } from "../src/data/loadFromFs.js";
import { teamToEnginePlayers } from "../src/data/playerData.js";
import { getTOReport } from "../src/sim/debugTally.js";
const lg = loadLeagueFromDir("data");
const home = lg.teams.find(t=>t.id==="san-antonio-spurs")!, away = lg.teams.find(t=>t.id==="oklahoma-city-thunder")!;
const N=10;
for(let s=1;s<=N;s++){newGame(s,{home:teamToEnginePlayers(home,"home"),away:teamToEnginePlayers(away,"away")});G.homeAttack="R";G.awayAttack="L";G.attackHoop="R";let g=0;while(!G.over&&g<200000){tick();g++;}}
const r=getTOReport();
console.log(`TOTAL TOV/game: ${(r.total/N).toFixed(1)}`);
console.log("by kind:", JSON.stringify(r.tos));
console.log("by zone:", JSON.stringify(r.byZone));
console.log("by kind:zone:", [...r.byKindZone.entries()].sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k}=${v}`).join(" "));
console.log("3-sec by intent:", [...r.threeSecByIntent.entries()].sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k}=${v}`).join(" "));
console.log("top offenders (tov/game):");
[...r.byPlayer.entries()].sort((a,b)=>b[1].count-a[1].count).slice(0,6).forEach(([n,d])=>console.log(`  ${n.padEnd(22)} ${(d.count/N).toFixed(1)}  pos ${d.pos} handle ${d.handle}`));
