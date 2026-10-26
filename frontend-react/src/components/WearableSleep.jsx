import { useState } from 'react';
import { Moon, Watch, Thermometer, Droplets, RefreshCw, LockKeyhole, ShieldCheck, Sparkles, ArrowUpRight, Info } from 'lucide-react';
import { DEMO } from '../config';
import { useWearableSessions } from '../hooks/useWearableSessions';
import './wearable-sleep.css';

const names={awake:'Αφύπνιση',awake_in_bed:'Ξύπνιος στο κρεβάτι',out_of_bed:'Εκτός κρεβατιού',rem:'REM',light:'Ελαφρύς',deep:'Βαθύς',sleeping:'Ύπνος',unknown:'Άγνωστο'};
const colors={awake:'#f5b879',awake_in_bed:'#f5b879',out_of_bed:'#f5b879',rem:'#c49bff',light:'#63bded',deep:'#7778ef',sleeping:'#94a3b8',unknown:'#64748b'};
const clock=ts=>new Date(ts*1000).toLocaleTimeString('el-GR',{hour:'2-digit',minute:'2-digit'});
const minutes=value=>{const n=Math.round(value||0);return n>=60?`${Math.floor(n/60)}ω ${n%60}λ`:`${n}λ`;};
const pct=value=>value==null?'—':`${value.toLocaleString('el-GR',{maximumFractionDigits:1})}%`;
const day=ts=>new Date(ts*1000).toLocaleDateString('el-GR',{weekday:'long',day:'numeric',month:'long'});
const SOURCES={sleep:'https://www.aasm.org/resources/pdf/adultsleepdurationconsensus.pdf',habits:'https://www.nhlbi.nih.gov/health/sleep-deprivation/healthy-sleep-habits',humidity:'https://www.epa.gov/mold/mold-course-chapter-9'};

function ScoreRing({value}) {
  const radius=59,circumference=2*Math.PI*radius;
  return <div className={`sl-ring ${value==null?'is-pending':''}`} aria-label={value==null?'Συνολικός δείκτης μη διαθέσιμος':`Συνολικός δείκτης ${value}%`}>
    <svg viewBox="0 0 144 144" aria-hidden="true"><circle cx="72" cy="72" r={radius} className="sl-ring__track"/>
      <circle cx="72" cy="72" r={radius} className="sl-ring__progress" strokeDasharray={circumference} strokeDashoffset={circumference*(1-(value||0)/100)}/></svg>
    <div><strong>{value==null?'—':value.toLocaleString('el-GR',{maximumFractionDigits:1})}{value!=null&&<small>%</small>}</strong><span>{value==null?'Σε αναμονή':'συνολικός δείκτης'}</span></div>
  </div>;
}

function Metric({icon:Icon,title,value,detail,tone,children}) {
  return <article className={`sl-card sl-metric sl-${tone}`}><div className="sl-card__heading"><span className="sl-icon"><Icon size={18}/></span><h3>{title}</h3></div>
    <div className="sl-metric__value">{value}</div><p className="sl-muted">{detail}</p>{children}</article>;
}

/** Shared time axis; no interpolation across awake stages or missing samples. */
function AlignedNight({night}) {
  const left=70,width=665,start=night.start,end=night.end;
  const x=ts=>left+(ts-start)/(end-start)*width;
  const lanes={awake:0,awake_in_bed:0,out_of_bed:0,rem:1,light:2,deep:3,sleeping:2,unknown:4};
  const chart=(metric,top,color)=>{
    const values=night.series.map(p=>p[metric]);
    const lo=values.length?Math.min(...values)-1:0,hi=values.length?Math.max(...values)+1:1;
    const y=v=>top+55-(v-lo)/(hi-lo)*40;
    return <g><text x="8" y={top+12} fill={color} fontSize="12">{metric==='temperature'?'°C':'%RH'}</text>
      {!!values.length&&<><text x="8" y={top+30} fill="#8297ac" fontSize="10">{hi.toFixed(1)}</text><text x="8" y={top+58} fill="#8297ac" fontSize="10">{lo.toFixed(1)}</text></>}
      {!values.length&&<text x="400" y={top+35} textAnchor="middle" fill="#8297ac" fontSize="12">Δεν υπάρχουν μετρήσεις για αυτές τις ώρες</text>}
      {night.series.map((p,i)=>{const previous=night.series[i-1];return <g key={`${p.segment}-${p.ts}`}>
        {previous&&p.segment===previous.segment&&p.ts-previous.ts<=90&&<line x1={x(previous.ts)} x2={x(p.ts)} y1={y(previous[metric])} y2={y(p[metric])} stroke={color} strokeWidth="2.2"/>}
        <circle cx={x(p.ts)} cy={y(p[metric])} r="1.8" fill={color}><title>{clock(p.ts)} · {p[metric].toFixed(1)}</title></circle>
      </g>;})}</g>;
  };
  return <svg viewBox="0 0 760 335" className="sl-timeline" role="img" aria-label="Στάδια ύπνου, θερμοκρασία και υγρασία στις ίδιες ώρες">
    {[0,1,2,3,4].map(i=>{const ts=start+(end-start)*i/4;return <g key={i}><line x1={x(ts)} x2={x(ts)} y1="12" y2="295" stroke="#7896b5" opacity=".12"/><text x={x(ts)} y="325" textAnchor="middle" fill="#a0b1c2" fontSize="11">{clock(ts)}</text></g>;})}
    {['Ξύπνιος','REM','Ελαφρύς','Βαθύς','Άγνωστο'].map((label,i)=><text key={label} x="8" y={26+i*22} fontSize="11" fill="#a0b1c2">{label}</text>)}
    {night.stages.map((s,i)=><rect key={i} x={x(s.start)} y={14+lanes[s.stage]*22} width={Math.max(1,x(s.end)-x(s.start))} height="13" rx="3" fill={colors[s.stage]}><title>{names[s.stage]} · {clock(s.start)}–{clock(s.end)}</title></rect>)}
    {chart('temperature',145,'#f5b879')}{chart('humidity',230,'#6ed9d1')}
  </svg>;
}

function Insights({night}) {
  const quality=night.quality_index;
  const rows=[];
  if(night.environment.coverage<.8) rows.push({type:'data',title:'Πρώτα, μια πλήρης νύχτα μετρήσεων',observation:`Ο αισθητήρας καλύπτει ${Math.round(night.environment.coverage*100)}% του καταγεγραμμένου ύπνου.`,action:'Άφησε τον αισθητήρα, τον υπολογιστή και τη γέφυρα σε λειτουργία. Ο συνολικός δείκτης θα εμφανιστεί όταν επαρκούν και οι δύο πηγές.'});
  if(night.asleep_minutes<420) rows.push({type:'sleep',title:'Δώσε χώρο στη διάρκεια',observation:`Το ρολόι κατέγραψε ${minutes(night.asleep_minutes)} ύπνου.`,action:'Για ενήλικες 18–60 ετών, η AASM/SRS συστήνει τουλάχιστον 7 ώρες τακτικά. Εξέτασε αν το πρόγραμμά σου αφήνει αρκετό χρόνο για ύπνο.',source:SOURCES.sleep,sourceName:'AASM / SRS'});
  if(night.environment.coverage>=.8&&night.environment.temperature_avg>quality?.ideal.temp_high) rows.push({type:'room',title:'Δοκίμασε ένα πιο δροσερό δωμάτιο',observation:`Μέση θερμοκρασία ${night.environment.temperature_avg.toFixed(1)} °C, πάνω από την επιλεγμένη ζώνη του Thalpos.`,action:'Κάνε μια μικρή, άνετη για εσένα αλλαγή πριν τον ύπνο και σύγκρινε αρκετές νύχτες. Το NIH συστήνει δροσερό περιβάλλον, χωρίς να ορίζει εδώ καθολική θερμοκρασία.',source:SOURCES.habits,sourceName:'NIH / NHLBI'});
  if(night.environment.coverage>=.8&&night.environment.humidity_avg>60) rows.push({type:'room',title:'Έλεγξε την παρατεταμένη υγρασία',observation:`Μέση υγρασία στον ύπνο ${Math.round(night.environment.humidity_avg)}%.`,action:'Έλεγξε πηγές υγρασίας και κατάλληλο αερισμό ή αφύγρανση. Η EPA προτείνει RH κάτω από 60% για έλεγχο υγρασίας και μούχλας· αυτό δεν είναι πρότυπο ποιότητας ύπνου.',source:SOURCES.humidity,sourceName:'US EPA'});
  if(night.awake_periods>0) rows.push({type:'sleep',title:'Παρακολούθησε τις αφυπνίσεις σε βάθος χρόνου',observation:`Καταγράφηκαν ${night.awake_periods} διαστήματα αφύπνισης από το ρολόι.`,action:'Δοκίμασε σταθερό ωράριο και ήσυχο, σκοτεινό δωμάτιο. Η καταγραφή δεν αποδεικνύει τι προκάλεσε ένα ξύπνημα και δεν αρκεί για διάγνωση.',source:SOURCES.habits,sourceName:'NIH / NHLBI'});
  rows.push({type:'routine',title:'Κράτησε σταθερή τη ρουτίνα σου',observation:'Η διάρκεια και τα στάδια δεν περιγράφουν από μόνα τους όλη την εμπειρία του ύπνου.',action:'Διατήρησε όσο γίνεται σταθερές ώρες ύπνου και αφύπνισης. Σύγκρινε τις μετρήσεις με το πώς νιώθεις το πρωί, χωρίς να κυνηγάς ένα «τέλειο 100%».',source:SOURCES.habits,sourceName:'NIH / NHLBI'});
  return <section className="sl-card sl-insights"><div className="sl-section-heading"><div><span className="sl-eyebrow">ΜΙΚΡΕΣ ΑΛΛΑΓΕΣ</span><h3>Τι μπορείς να βελτιώσεις</h3></div><Sparkles size={21}/></div>
    <div className="sl-insights__grid">{rows.slice(0,4).map((row,i)=><article key={row.title} className="sl-insight"><span className="sl-insight__number">{String(i+1).padStart(2,'0')}</span><div><h4>{row.title}</h4><p className="sl-insight__observation">{row.observation}</p><p>{row.action}</p>{row.source&&<a href={row.source} target="_blank" rel="noreferrer">{row.sourceName}<ArrowUpRight size={12}/></a>}</div></article>)}</div>
    <p className="sl-fineprint">Οι προτάσεις υποστηρίζουν προσωπική παρατήρηση. Δεν εγγυώνται βελτίωση ή «τέλειο ύπνο». Αν οι δυσκολίες ύπνου επιμένουν ή επηρεάζουν την ημέρα σου, συζήτησέ τες με επαγγελματία υγείας.</p>
  </section>;
}

export default function WearableSleep({room}) {
  const [token,setToken]=useState(()=>sessionStorage.getItem('thalpos-sleep-key')||'');
  const [activeToken,setActiveToken]=useState(()=>sessionStorage.getItem('thalpos-sleep-key')||'');
  const [refreshId,setRefreshId]=useState(0),[targetHours,setTargetHours]=useState(8),[picked,setPicked]=useState('');
  const {data,error:loadError,loading,refreshed}=useWearableSessions(room,activeToken,refreshId,targetHours);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  const night=data?.sessions.find(s=>s.id===picked)||data?.sessions[0];
  const quality=night?.quality_index;
  function unlock(){if(DEMO){setError('Τα προσωπικά δεδομένα δεν εμφανίζονται στο demo.');return;}sessionStorage.setItem('thalpos-sleep-key',token.trim());setActiveToken(token.trim());setRefreshId(v=>v+1);setError('');}
  function lock(){sessionStorage.removeItem('thalpos-sleep-key');setToken('');setActiveToken('');setPicked('');setError('');}
  async function remove(){
    if(!window.confirm('Να διαγραφούν όλες οι εισαγωγές ύπνου από αυτή τη γέφυρα; Το Mi Fitness και το Health Connect δεν αλλάζουν.'))return;
    setBusy(true);try{const response=await fetch('/wearable/sessions',{method:'DELETE',headers:{Authorization:`Bearer ${activeToken}`},signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error('Η διαγραφή δεν ολοκληρώθηκε.');lock();}catch(e){setError(e.message);}finally{setBusy(false);}
  }
  return <section className="sl-dashboard">
    <div className="sl-toolbar"><span className="sl-connection"><i className={loadError?'is-stale':''}/>{activeToken?(refreshed?'Αυτόματη ανανέωση ενεργή':'Σύνδεση…'):'Προσωπική προβολή'}</span><div>{refreshed&&<span className="sl-updated">{clock(refreshed/1000)}</span>}{activeToken&&<><button type="button" className="sl-icon-button" aria-label="Load / refresh nights" onClick={()=>setRefreshId(v=>v+1)} disabled={loading}><RefreshCw size={16}/><span>Ανανέωση</span></button><button type="button" className="sl-icon-button" aria-label="Lock" onClick={lock}><LockKeyhole size={16}/><span>Κλείδωμα</span></button></>}</div></div>
    {(error||loadError)&&<div className="sl-alert" role="alert">{error||loadError}</div>}
    <details className="sl-connect sl-card" open={!activeToken}><summary><ShieldCheck size={17}/>{activeToken?'Σύνδεση και ιδιωτικότητα':'Σύνδεσε το προσωπικό σου ιστορικό'}</summary><p>Το κλειδί διατηρείται μόνο στη συνεδρία αυτής της καρτέλας. Ο συγχρονισμός από το κινητό λειτουργεί ανεξάρτητα.</p><form onSubmit={e=>{e.preventDefault();unlock();}}><label>Κλειδί σύνδεσης<input type="password" value={token} onChange={e=>setToken(e.target.value)} autoComplete="off" required minLength={32}/></label><button type="submit" className="sl-primary" disabled={busy||loading}>Φόρτωση ύπνου</button></form>{data&&<button type="button" className="sl-delete" disabled={busy} onClick={remove}>Διαγραφή εισαγωγών ύπνου</button>}</details>
    {!night&&<div className="sl-card sl-empty"><Moon size={36}/><h3>{loading?'Φορτώνουμε τις νύχτες σου':'Η νύχτα σου, σε μια εικόνα'}</h3><p>{data?'Δεν υπάρχουν εισαγωγές για αυτό το δωμάτιο τις τελευταίες 30 ημέρες. Συγχρόνισε πρώτα από το κινητό.':'Σύνδεσε το ιστορικό σου για να δεις ύπνο, περιβάλλον και χρήσιμες παρατηρήσεις μαζί.'}</p></div>}
    {night&&<>
      <div className="sl-night-heading"><div><span className="sl-eyebrow">Η ΑΝΑΣΚΟΠΗΣΗ ΣΟΥ</span><h2>{day(night.end)}</h2><p><Moon size={14}/>{clock(night.start)} — {clock(night.end)}<span>·</span>{night.room}<span>·</span>Mi Fitness</p></div><label className="sl-select-label">Επιλογή νύχτας<select aria-label="Sleep session" value={night.id} onChange={e=>setPicked(e.target.value)}>{data.sessions.map(s=><option key={s.id} value={s.id}>{new Date(s.end*1000).toLocaleDateString('el-GR')} · {clock(s.start)}–{clock(s.end)}</option>)}</select></label></div>
      <div className="sl-overview">
        <article className="sl-card sl-total"><div className="sl-card__heading"><span className="sl-icon"><Sparkles size={18}/></span><h3>Συνολικός δείκτης</h3><span className="sl-tag">Πειραματικός</span></div><ScoreRing value={quality?.combined}/><p className="sl-total__caption">Ύπνος <b>50%</b><span>+</span> Περιβάλλον <b>50%</b></p><p className="sl-muted">{quality?.combined==null?'Περιμένουμε επαρκή δεδομένα και από τις δύο πηγές.':'Μια κοινή εικόνα της νύχτας σου, με ξεκάθαρο υπολογισμό.'}</p></article>
        <Metric icon={Watch} title="Ο ύπνος σου" value={minutes(night.asleep_minutes)} detail="Καταγεγραμμένος χρόνος ύπνου" tone="violet"><div className="sl-facts"><div><span>Δείκτης ύπνου</span><b>{pct(quality?.watch_component)}</b></div><div><span>Αφυπνίσεις</span><b>{night.awake_periods}</b></div></div><label className="sl-target">Προσωπικός στόχος<select aria-label="Personal sleep duration target" value={targetHours} onChange={e=>setTargetHours(Number(e.target.value))}>{Array.from({length:17},(_,i)=>4+i*.5).map(h=><option key={h} value={h}>{h} ώρες</option>)}</select></label></Metric>
        <Metric icon={Thermometer} title="Το περιβάλλον σου" value={pct(quality?.room_component)} detail="Μόνο όσο το ρολόι κατέγραψε ύπνο" tone="mint"><div className="sl-environment"><div><Thermometer size={17}/><b>{night.environment.temperature_avg==null?'—':night.environment.temperature_avg.toFixed(1)}<small>°C</small></b><span>Θερμοκρασία</span></div><div><Droplets size={17}/><b>{night.environment.humidity_avg==null?'—':Math.round(night.environment.humidity_avg)}<small>%</small></b><span>Υγρασία</span></div></div><div className="sl-coverage"><span>Κάλυψη αισθητήρα <b>{Math.round(night.environment.coverage*100)}%</b></span><div><i style={{width:`${night.environment.coverage*100}%`}}/></div></div></Metric>
      </div>
      <section className="sl-card sl-stages"><div className="sl-section-heading"><div><span className="sl-eyebrow">Η ΣΥΝΘΕΣΗ ΤΗΣ ΝΥΧΤΑΣ</span><h3>Στάδια ύπνου</h3></div><span className="sl-muted">Εκτιμήσεις ρολογιού</span></div><div className="sl-stage-strip" aria-hidden="true">{night.stages.map((s,i)=><span key={i} style={{width:`${(s.end-s.start)/(night.end-night.start)*100}%`,background:colors[s.stage]}}/>)}</div><div className="sl-stage-facts">{['deep','light','rem','awake'].map(key=><div key={key}><span><i style={{background:colors[key]}}/>{names[key]}</span><b>{minutes(night.stage_minutes[key])}</b><small>{Math.round((night.stage_minutes[key]||0)/((night.end-night.start)/60)*100)}% της συνεδρίας</small></div>)}</div></section>
      {night.overlap_warning&&<div className="sl-data-note" role="status"><Info size={16}/><span>Υπάρχουν επικαλυπτόμενες εγγραφές. Εμφανίζεται η πιο πρόσφατη εκδοχή, χωρίς διπλή πρόσθεση χρόνου. Σύγκρινέ τη με το Mi Fitness.</span></div>}
      <section className="sl-card sl-chart-card"><div className="sl-section-heading"><div><span className="sl-eyebrow">ΣΤΗΝ ΙΔΙΑ ΧΡΟΝΟΓΡΑΜΜΗ</span><h3>Ύπνος και συνθήκες δωματίου</h3></div><span className="sl-tag">Μόνο ώρες ύπνου</span></div><p className="sl-muted">Θερμοκρασία και υγρασία παραμένουν κενές στις αφυπνίσεις και στα διαστήματα χωρίς μετρήσεις.</p><div className="sl-chart-scroll"><AlignedNight night={night}/></div><p className="sl-swipe">Σύρε οριζόντια για να δεις όλη τη νύχτα →</p></section>
      <Insights night={night}/>
      <details className="sl-card sl-method"><summary><Info size={17}/>Πώς υπολογίζονται οι δείκτες</summary><p>Ύπνος: μέσος όρος διάρκειας σε σχέση με τον προσωπικό στόχο και συνέχειας ύπνου. Απαιτούνται γνωστά στάδια για τουλάχιστον 90% της συνεδρίας. Ο στόχος διάρκειας είναι προσωπική επιλογή.</p><p>Περιβάλλον: σταθμισμένος στον παρατηρημένο χρόνο δείκτης στις ζώνες {quality?.ideal.temp_low}–{quality?.ideal.temp_high} °C και {quality?.ideal.hum_low}–{quality?.ideal.hum_high}% RH. Από το 100 αφαιρούνται έως 50 μονάδες για θερμοκρασία (10 ανά °C εκτός ζώνης) και έως 50 για υγρασία (2,5 ανά μονάδα RH εκτός ζώνης). Απαιτείται κάλυψη τουλάχιστον 80% του ύπνου.</p><p>Συνολικός δείκτης = 50% ύπνος + 50% περιβάλλον. Τα βάρη και οι ζώνες είναι επιλογές του prototype, όχι παγκόσμιο πρότυπο. Δεν είναι ο έτοιμος βαθμός της Xiaomi, πιθανότητα καλού ύπνου ή ιατρική αξιολόγηση. Τα REM και deep δεν βαθμολογούνται με αυθαίρετα «ιδανικά» ποσοστά.</p>{night.unclassified_minutes>0&&<p>Άγνωστα διαστήματα: {minutes(night.unclassified_minutes)}. Δεν συμπληρώνονται με υποθετικά στάδια.</p>}</details>
    </>}
  </section>;
}
