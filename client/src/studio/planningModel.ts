// @ts-nocheck — direct port of the Campaign Management prototype's planning-model.js.
// Logic is intentionally unchanged; exported shapes are typed below.
import schema from './campaign-schema.json';
import { options, fixtureMasters, brands } from './demoData';
export const definitions: Record<string, FieldDef> = Object.fromEntries(schema.fields.map(f => [f.id,f]));
export interface FieldDef { id: string; section: string; field: string; owner: string; control: string; rules: string; source: string }
export type Group = [name: string, owner: string, ids: string[]];
export const sections: string[] = ['General','Contact','Email','Touchpoint'];
export const groups: Record<string, Group[]> = {
 General:[['Campaign setup','Delivery Manager',['10','11','12','13','14','15','16','17','18','19','20','20.1','20.2']],['Campaign brief','Agency of Record',['21','22','22.1','22.2','22.3','23','24','24.1','25','26','27']],['Segmentation & journey rules','DM through XM/MS',['28','29','30','31']]],
 Contact:[['Project Team','Delivery Manager',['1','2','3','4','5','6','7','8','9']]],
 Email:[['Content & lifecycle','AoR / DM',['32','33','34','35','36','37']],['Message','AoR / DM',['39','40','41','42']],['Personalization','AoR / DM',['38','38.1']],['A/B testing','AoR / DM',['43','43.1','43.2','43.3','43.4']],['Asset handoff','AoR / DM',['44','44.1','44.2','44.3']]],
 Touchpoint:[['Inherited context','Campaign / Email',['45','46','47']],['Journey settings','AoR / DM',['48','49','49.1']]],
};
export const label = (section,index) => `${section} ${String(index+1).padStart(2,'0')}`;
export const escape = (s='') => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function planning(state) {
 if (!state.planning) state.planning={section:'General',view:'memory',mode:'LIVE',role:'Delivery Manager',meta:{},emails:[],touchpoints:[],active:0,messages:{General:[],Contact:[],Email:[],Touchpoint:[],Flow:[]},drafts:{},recent:[],validation:'incomplete',revision:'',version:0,flow:{nodes:[],version:-1,status:'ready',zoom:1,selected:null},editing:null};
 const p=state.planning;
 // The Delivery Manager owns sign-off: there is no SA validation step.
 if(p.validation==='awaiting')p.validation='validated';
 if(p.validation==='revision_requested')p.validation='incomplete';
 if(p.view==='validation')p.view='memory';
 for(const id of ['20','22.1']) if(state.fields[id]&&!p.meta[id])p.meta[id]={source:'Source default'};
 reconcileMaster(state);
 state.fields['11'] ||= state.channel || '';
 return p;
}
export function target(state,section=planning(state).section,index=planning(state).active) {
 const p=planning(state);
 return section==='Email'?p.emails[index]:section==='Touchpoint'?p.touchpoints[index]:{fields:state.fields,meta:p.meta};
}
export function value(state,id,section,index) {return target(state,section,index)?.fields[id] || '';}
export function applicable(state,id,section=planning(state).section,index=planning(state).active) {
 const v=k=>value(state,k,section,index); const general=k=>state.fields[k]||'';
 if (id.startsWith('20.')) return general('20')==='Yes';
 if (id.startsWith('22.')) {if(!/Real-time/.test(general('22')))return false;return id==='22.1'||(general('22.1')==='Yes'&&(id==='22.2'||general('22.2')==='Yes'));}
 if(id==='24') return general('11')==='HQE';
 if(id==='24.1')return general('11')==='SMS';
 if(id==='38.1')return v('38')==='Yes';
 if(id.startsWith('43.'))return v('43')==='Yes';
 if(id.startsWith('44.'))return v('44')==='Yes';
 if(id==='49.1')return v('49')==='Yes';
 return true;
}
export function choices(state,id) {
 if(id==='11')return ['HQE','SMS']; // Preserve existing single-channel demo preview; conflict stays visible.
 if(id==='14')return brands.map(b=>b.name).concat('Demo Brand A');
 if(id==='26'||id==='18')return fixtureMasters[id];
 if(options[id])return options[id].filter(v=>id!=='22'||state.fields['11']!=='SMS'||v!=='Model based');
 if(['13','38','43','44','49'].includes(id))return ['No','Yes'];
 return null;
}
export function issue(state,id,section,index) {
 const v=value(state,id,section,index); if(!v)return 'Needs input';
 const meta=target(state,section,index)?.meta[id];
 if(meta?.waiting)return 'Waiting / dependency';
 if(meta?.conflict)return 'Conflicts with brand master';
 if(meta?.unconfirmed)return 'Needs confirmation';
 if(id==='19'&&!/^\d{8}$/.test(v))return 'Enter exactly 8 digits';
 if(id==='10'&&!/^[a-z0-9-]+$/i.test(v))return 'Use an alphanumeric ID';
 if(['24','24.1','43.1'].includes(id)&&(!/^\d+$/.test(v)||Number(v)<1))return 'Enter a positive whole number';
 if(['25','33','34','35','37'].includes(id)&&Number.isNaN(Date.parse(v)))return 'Enter a valid date';
 if(id==='9') {const emails=v.split(/[,;\s]+/).filter(Boolean);if(emails.length>20||new Set(emails.map(s=>s.toLowerCase())).size!==emails.length||emails.some(e=>!/^\S+@\S+\.\S+$/.test(e)))return 'Use 1–20 unique email addresses';}
 if(id==='48'&&!/^\d+(?:\.\d+)?\s*(hours?|days?)$/i.test(v))return 'Use a number with Hours or Days';
 if(id==='43.2'&&v.match(/\d+(?:\.\d+)?/g)?.reduce((a,b)=>a+Number(b),0)!==100)return 'Test split must total 100%';
 const allowed=choices(state,id);if(allowed&&!allowed.some(x=>x.toLowerCase()===v.toLowerCase()))return 'Select a supported value';
 if(['29','30'].includes(id)){const other=state.fields[id==='29'?'30':'29']||'';if(v.split(',').some(s=>other.toLowerCase().split(',').map(x=>x.trim()).includes(s.trim().toLowerCase())))return 'Inclusion and exclusion must not overlap';}
 return '';
}
export function required(state,section,index=planning(state).active) {
 let ids=groups[section].flatMap(g=>g[2]).filter(id=>applicable(state,id,section,index));
 const optional=['29','30','35','39','40','44.1'];
 if(section==='Touchpoint'&&index===planning(state).emails.length-1)optional.push('48');
 return ids.filter(id=>!optional.includes(id));
}
export function unresolved(state,section,index) {return required(state,section,index).filter(id=>issue(state,id,section,index));}
export function sectionStatus(state,section) {
 const p=planning(state);
 if(section==='General'&&p.validation==='validated')return 'Complete';
 if(['Email','Touchpoint'].includes(section))return p.emails.length&&p.emails.every((_,i)=>!unresolved(state,section,i).length)?'Complete':'Needs input';
 return unresolved(state,section).length?'Needs input':'Complete';
}
export function addEmail(state) {
 const p=planning(state);p.emails.push({id:`email-${p.emails.length+1}`,fields:{},meta:{}});p.touchpoints.push({emailId:p.emails.at(-1).id,fields:{},meta:{}});p.version++;inherit(state);return p.emails.length-1;
}
export function inherit(state) {
 const p=planning(state);
 p.touchpoints.forEach((t,i)=>{for(const [id,v,source]of [['45',state.fields['11'],'campaign'],['46',p.emails[i].fields['36'],label('Email',i)],['47',p.emails[i].fields['43'],label('Email',i)]]){t.fields[id]=v||'';t.meta[id]={source:`Inherited · From ${source}`};}});
}
export function setField(state,id,input,section=planning(state).section,index=planning(state).active,source='Provided by you') {
 const t=target(state,section,index); if(!t)return false;
 if(id==='19'&&!/OMS/.test(source))return false; // Campaign Code comes from OMS only
 const p=planning(state);let v=String(input).trim().replace(/^[{"“]+|[}"”]+$/g,'').trim();
 const waiting=/^(?:still )?(?:pending|unknown|not available|not yet available|waiting.*|tbd)$/i.test(v);
 const allowed=choices(state,id);if(allowed)v=allowed.find(x=>x.toLowerCase()===v.toLowerCase())||v;
 const changed=t.fields[id]!==v||!!t.meta[id]?.waiting!==waiting;
 t.fields[id]=v;t.meta[id]={source,waiting};
 if(['14','18','26'].includes(id)&&allowed?.includes(v))t.meta[id].source='Provided by you · Local demo master';
 // Unsupported master data can be retained for review, but never treated as verified.
 if(['15','16','29','30'].includes(id))t.meta[id].unconfirmed=true;
 if(id==='49.1')t.meta[id].source='Provided by you · Source options unresolved';
 if(id==='11')state.channel=v;
 if(id==='12'){state.fields['13']=v==='New Brand Launch'?'Yes':'No';p.meta['13']={source:'Inherited · Request Type'};}
 if(id==='14') {const b=brands.find(x=>x.name===v);if(b){state.fields['15']=b.indication;state.fields['16']=b.therapeuticArea;for(const n of ['15','16'])p.meta[n]={source:'Mapped from local demo Brand fixture'};}}
 if(id==='24'&&/^\d+$/.test(v)&&Number(v)<=100){while(p.emails.length<Number(v))addEmail(state);}
 if(changed){p.version++;if(section==='General'&&p.validation==='validated')p.validation='incomplete';p.recent.push({section,index,id});p.recent=p.recent.slice(-30);}
 inherit(state);return changed;
}
// Indication and Therapeutic Area are checked against the brand master. A value that
// matches the master for the chosen brand is accepted on the spot; only a value the
// master can't vouch for stays "Needs confirmation" and gets asked about.
function reconcileMaster(state) {
 const p=state.planning,brand=state.fields['14'];
 if(!p||!brand)return;
 const known=brands.filter(b=>b.name===brand);
 for(const [id,key] of [['15','indication'],['16','therapeuticArea']]) {
  const v=String(state.fields[id]||'').trim().toLowerCase();
  if(!v||!p.meta[id]?.unconfirmed||!known.length)continue;
  const master=[...new Set(known.map(b=>String(b[key]||'').trim()).filter(Boolean))];
  if(master.some(m=>m.toLowerCase()===v)) p.meta[id]={...p.meta[id],unconfirmed:false,conflict:undefined,source:'Matches brand master'};
  else if(master.length) p.meta[id]={...p.meta[id],conflict:{master}};
 }
}
export function evaluateGeneral(state) {
 const p=planning(state);const complete=!unresolved(state,'General').length;
 if(complete)p.validation='validated'; // DM sign-off: complete General unlocks Flow Planner
 else if(p.validation==='validated')p.validation='incomplete';
 requestCampaignCode(state);
 notifyAoR(state);
 return complete;
}
// Campaign Code is provided by OMS. Once every General field above it
// (TACTPlan ID → Audience Type) is resolved, OMS is notified once and the
// conversation records it; the field waits on OMS until a code arrives.
export const OMS_PREREQUISITES=['10','11','12','13','14','15','16','17','18'];
export function requestCampaignCode(state) {
 const p=planning(state);
 if(p.oms||state.fields['19'])return false;
 if(!OMS_PREREQUISITES.every(id=>!applicable(state,id,'General',0)||!issue(state,id,'General',0)))return false;
 p.oms={status:'requested',requestedAt:new Date().toISOString()};
 p.meta['19']={source:'Requested from OMS',waiting:true};
 p.messages.General.push({role:'agent',text:'',lines:['I’ve asked OMS to issue the Campaign Code.','That one is theirs to provide, so there’s nothing you need to do. I’ll drop it in here the moment it arrives.'],event:'oms'});
 return true;
}
// The AoR owns the campaign brief. Once nothing in General is left for the
// Delivery Manager (Campaign Code aside — that is OMS's), AoR is notified once.
const dmOwns=id=>id!=='19'&&/\bDM\b/.test(definitions[id].owner);
export function notifyAoR(state) {
 const p=planning(state);
 if(p.aor)return false;
 const open=unresolved(state,'General',0).filter(id=>id!=='19');
 if(open.some(dmOwns)||!open.length)return false;
 p.aor={status:'notified',requestedAt:new Date().toISOString(),fields:open};
 p.messages.General.push({role:'agent',text:'',lines:[`I’ve also passed the campaign brief over to AoR. They’ll take care of the ${open.map(id=>definitions[id].field.replace(/ \/ Friendly From/,'').toLowerCase()).join(', ').replace(/, ([^,]*)$/,' and $1')}.`,'I’ll add each detail to the canvas as they provide it.'],event:'aor'});
 return true;
}
export function provideCampaignCode(state,code) {
 const p=planning(state);
 const ok=setField(state,'19',code,'General',0,'Provided by OMS');
 if(!ok&&state.fields['19']!==code)return false;
 p.oms={...(p.oms||{}),status:'provided',providedAt:new Date().toISOString()};
 p.messages.General.push({role:'agent',text:'',lines:[`Good news: OMS has issued the Campaign Code, ${code}.`,'I’ve added it to the canvas.'],event:'oms'});
 evaluateGeneral(state);
 return true;
}
const generalSnapshot=state=>JSON.stringify(groups.General.flatMap(g=>g[2]).map(id=>[state.fields[id],planning(state).meta[id]?.waiting,planning(state).meta[id]?.unconfirmed]));
export function revise(state,feedback='') {const p=planning(state);p.validation='revision_requested';p.revision=feedback;p.revisionSnapshot=generalSnapshot(state);p.role='Delivery Manager';p.section='General';p.view='memory';}
export function resubmit(state) {const p=planning(state);if(p.validation==='revision_requested'&&generalSnapshot(state)!==p.revisionSnapshot&&!unresolved(state,'General').length){p.validation='awaiting';return true;}return false;}
export function validate(state) {const p=planning(state);if(p.role!=='Solution Architect'||p.validation!=='awaiting'||unresolved(state,'General').length)return false;p.validation='validated';return true;}
const extraAliases={'4':['Delivery Coordinator','Project Manager','Delivery Coordinator / PM'],'10':['TACTPlan ID'],'20':['STO'],'21':['campaign name'],'23':['goal'],'24':['Number of emails'],'24.1':['Number of SMS'],'25':['desired go-live date','desired campaign go-live date','go-live date'],'26':['From Name','Friendly From'],'27':['Segment Names'],'29':['Specialty Inclusions'],'30':['Specialty Exclusions'],'31':['Exit Criteria'],'37':['deployment date','deploy date'],'39':['subject'],'40':['pre-header','pre header'],'43':['A/B testing'],'48':['wait time','wait'],'49':['resend'],'38.1':['personalization area'],'22.2':['survey sheet available'],'22.3':['survey metadata sheet']};
const regexEscape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
// Deliberately local, deterministic language mapping. Original messages remain visible.
// Unsupported language is acknowledged, never silently passed off as AI extraction.
export function mapMessage(state,text,section=planning(state).section) {
 const p=planning(state);const mapped=[];const errors=[];
 const refs=[...text.matchAll(/\b(?:For\s+)?(Email|Touchpoint)\s+0*(\d+)\b/gi)];
 const chunks=refs.length?refs.map((m,i)=>({section:m[1].toLowerCase()==='email'?'Email':'Touchpoint',index:Number(m[2])-1,text:text.slice(m.index+m[0].length,refs[i+1]?.index??text.length)})):[{section,index:p.active,text}];
 if(refs.length&&refs[0].index>0)chunks.unshift({section,index:p.active,text:text.slice(0,refs[0].index)});
 for(const chunk of chunks) {
  if(['Email','Touchpoint'].includes(chunk.section)&&!target(state,chunk.section,chunk.index)){errors.push(`${label(chunk.section,chunk.index)} does not exist. Add the email or specify the campaign email count first.`);continue;}
  const ids=(['Email','Touchpoint'].includes(chunk.section)?groups[chunk.section]:[...groups.General,...groups.Contact]).flatMap(g=>g[2]);
  const aliasMap=new Map();ids.forEach(id=>[definitions[id].field,...(extraAliases[id]||[])].forEach(a=>aliasMap.set(a.toLowerCase(),id)));
  const aliases=[...aliasMap.keys()].sort((a,b)=>b.length-a.length);
  const matcher=new RegExp(`\\b(${aliases.map(regexEscape).join('|')})(?:\\s*(?:is|are|:|=|should be|should|with)\\s*|\\s+)`,'gi');
  const matches=[...chunk.text.matchAll(matcher)];
  for(let i=0;i<matches.length;i++){
   const m=matches[i],id=aliasMap.get(m[1].toLowerCase());
   if(['45','46','47'].includes(id))continue;
   let v=chunk.text.slice(m.index+m[0].length,matches[i+1]?.index??chunk.text.length).replace(/^[\s,:]+|[\s.,;]+$/g,'').replace(/\s+(?:and|with|the)$/i,'').replace(/^[{“"]|[}”"]$/g,'').trim();
   // Sentence boundaries, not arbitrary commas (lists and prose retain their content).
   v=v.split(/\.\s+(?=[A-Z])/)[0].replace(/[.;,]+$/,'').trim();
   if(!v)continue;
   const dest=Number(id)<10?'Contact':Number(id)<32?'General':chunk.section;
   if(['no','false','disabled','not needed'].includes(v.toLowerCase()))v='No';if(['yes','true','enabled'].includes(v.toLowerCase()))v='Yes';
   setField(state,id,v,dest,chunk.index);mapped.push({section:dest,index:chunk.index,id});
  }
  if(['Email','Touchpoint'].includes(chunk.section)) {
   for(const [re,id,v]of [[/does not need A\/B testing/i,'43','No'],[/does not need resend/i,'49','No'],[/resend enabled/i,'49','Yes']])if(re.test(chunk.text)){setField(state,id,v,chunk.section,chunk.index);mapped.push({section:chunk.section,index:chunk.index,id});}
   const wait=chunk.text.match(/should wait\s+([\d.]+\s*(?:hours?|days?))/i);if(wait){setField(state,'48',wait[1],chunk.section,chunk.index);mapped.push({section:chunk.section,index:chunk.index,id:'48'});}
  }
 }
 const count=text.match(/(?:include|have|contains?)\s+(\d+)\s+emails?\b/i);if(count){setField(state,'24',count[1],'General');mapped.push({section:'General',id:'24'});}
 evaluateGeneral(state);return {mapped,errors};
}
export function nextPrompt(state,section=planning(state).section) {
 const p=planning(state);
 if(section==='General'&&p.validation==='awaiting')return 'General Details are complete. I’ve started the validation handoff to the Solution Architect. You don’t need to wait. We can continue with Email or Touchpoint planning while General is being validated.';
 if(section==='General'&&p.validation==='validated')return 'General Details are validated. Flow Planner is available when you are ready to instruct it.';
 if(section==='General'&&p.validation==='revision_requested')return `General Details need revision. ${p.revision || 'Review and correct the General context.'} Your Email and Touchpoint progress is preserved.`;
 if(['Email','Touchpoint'].includes(section)&&!p.emails.length)return 'No emails have been added yet. Add an email to start planning; each email will have one linked Touchpoint detail set.';
 const inherited=section==='Touchpoint'?['45','46','47']:[];
 const missing=unresolved(state,section).filter(id=>!target(state,section)?.meta[id]?.waiting&&!inherited.includes(id));
 const group=groups[section].find(g=>g[2].some(id=>missing.includes(id)));
 const ids=group?group[2].filter(id=>missing.includes(id)):[];
 const waiting=unresolved(state,section).filter(id=>target(state,section)?.meta[id]?.waiting);
 return ids.length?`Share ${group[0].toLowerCase()} together in one response. I’m still looking for: ${ids.map(id=>definitions[id].field).join(' · ')}.`:waiting.length?`These details remain waiting / dependency: ${waiting.map(id=>definitions[id].field).join(' · ')}. You can continue in another section.`:inherited.some(id=>issue(state,id,section))?'The remaining inherited context needs input in General or the linked Email. Open that section to supply it once; this Touchpoint will update automatically.':'The required details in this section are captured. You can review optional information or continue in another section.';
}
export function flowNodes(state) {
 const p=planning(state),nodes=[];
 if(state.fields['27'])nodes.push({id:'segment',type:'Segment',title:state.fields['27'],source:'General'});
 p.emails.forEach((e,i)=>{nodes.push({id:e.id,type:'Email',title:e.fields['36']||label('Email',i),source:label('Email',i)});const t=p.touchpoints[i];nodes.push({id:`touch-${e.id}`,type:'Touchpoint',title:t.fields['46']||label('Touchpoint',i),source:label('Touchpoint',i)});if(t.fields['49']==='Yes')nodes.push({id:`resend-${e.id}`,type:'Condition',title:t.fields['49.1']||'Resend · Needs input',source:label('Touchpoint',i)});if(t.fields['48']&&i<p.emails.length-1)nodes.push({id:`wait-${e.id}`,type:'Wait',title:t.fields['48'],source:label('Touchpoint',i)});});
 return nodes;
}
export function beginFlow(state,instruction) {
 const p=planning(state);if(p.role!=='Solution Architect'||p.validation!=='validated')return 'General must be validated by the Solution Architect first.';
 if(/^(?:generating|updating)$/.test(p.flow.status))return 'The current instruction is still processing.';
 p.messages.Flow.push({role:'user',text:instruction});
 if(/(?:generate|create|update|refresh).*(?:flow|campaign details)/i.test(instruction)) {
  p.flow.pending=flowNodes(state);p.flow.pendingVersion=p.version;
 } else {
  const selected=p.flow.nodes.find(n=>n.id===p.flow.selected);
  const add=instruction.match(/add (?:a )?wait(?: step)?(?: of)?\s+(\d+\s*(?:hours?|days?))/i);
  const move=instruction.match(/move (?:selected(?: node)?|.+?) (before|after) (.+)/i);
  if(add&&selected){p.flow.pending=p.flow.nodes.map(n=>({...n}));p.flow.pending.splice(p.flow.pending.findIndex(n=>n.id===selected.id)+1,0,{id:`instruction-${p.flow.revision||0}-${p.flow.nodes.length}`,type:'Wait',title:add[1],source:'Explicit SA instruction'});}
  else if(move&&selected){const dest=p.flow.nodes.find(n=>n.title.toLowerCase()===move[2].trim().toLowerCase());if(!dest||dest.id===selected.id)return 'Name a different existing destination node.';p.flow.pending=p.flow.nodes.filter(n=>n.id!==selected.id).map(n=>({...n}));p.flow.pending.splice(p.flow.pending.findIndex(n=>n.id===dest.id)+(move[1].toLowerCase()==='after'?1:0),0,{...selected});}
  else return 'Select a node, then say “Add a wait of 2 days after the selected node” or “Move selected after [node name]”. You can also ask to update the flow using the latest campaign details.';
  p.flow.pendingVersion=p.flow.version;
 }
 p.flow.status=p.flow.nodes.length?'updating':'generating';p.flow.startedAt=Date.now();return '';
}
export function finishFlow(state) {const p=planning(state);if(!p.flow.pending)return;p.flow.nodes=p.flow.pending;p.flow.version=p.flow.pendingVersion;p.flow.pending=null;p.flow.status='generated';p.flow.revision=(p.flow.revision||0)+1;p.messages.Flow.push({role:'agent',text:'Flow Generated. What would you like to change?'});}
