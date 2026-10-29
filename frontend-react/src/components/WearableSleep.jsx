import { useState } from 'react';
import { Moon, Watch, Thermometer, Droplets, RefreshCw, LockKeyhole, ShieldCheck, Sparkles, ArrowUpRight, Info, TrendingUp, AlertCircle, BookOpen, ScatterChart } from 'lucide-react';
import { DEMO } from '../config';
import { useWearableSessions } from '../hooks/useWearableSessions';
import { useElementWidth } from '../hooks/useElementWidth';
import './wearable-sleep.css';

const names={awake:'Αφύπνιση',awake_in_bed:'Ξύπνιος στο κρεβάτι',out_of_bed:'Εκτός κρεβατιού',rem:'REM',light:'Ελαφρύς',deep:'Βαθύς',sleeping:'Ύπνος',unknown:'Άγνωστο'};
const colors={awake:'#f5b879',awake_in_bed:'#f5b879',out_of_bed:'#f5b879',rem:'#c49bff',light:'#63bded',deep:'#7778ef',sleeping:'#94a3b8',unknown:'#64748b'};
const clock=ts=>new Date(ts*1000).toLocaleTimeString('el-GR',{hour:'2-digit',minute:'2-digit'});
const minutes=value=>{const n=Math.round(value||0);return n>=60?`${Math.floor(n/60)}ω ${n%60}λ`:`${n}λ`;};
const pct=value=>value==null?'—':`${value.toLocaleString('el-GR',{maximumFractionDigits:1})}%`;
/** The header reads "Νύχτα προς 28 Οκτωβρίου" so the user doesn't confuse the night that
 *  ended this morning with "today". The wake-up date is still what identifies the night. */
const nightOf=ts=>`Νύχτα προς ${new Date(ts*1000).toLocaleDateString('el-GR',{weekday:'long',day:'numeric',month:'long'})}`;
const SOURCES={sleep:'https://doi.org/10.5664/jcsm.4758',habits:'https://www.nhlbi.nih.gov/health/sleep-deprivation/healthy-sleep-habits',humidity:'https://www.epa.gov/mold/mold-course-chapter-9',temperature:'https://doi.org/10.1016/j.scitotenv.2023.165623',home:'https://doi.org/10.1080/09613218.2025.2482959'};
/** The studies behind the bands and the method. Shown in full in the method panel. */
const REFERENCES=[
  {cite:'Ohayon, M. et al. (2017). National Sleep Foundation’s sleep quality recommendations: first report. Sleep Health, 3(1), 6–19.',url:'https://doi.org/10.1016/j.sleh.2016.11.006',use:'Τι μετράει ως ποιότητα ύπνου. Τα στάδια (deep/REM) δεν θεωρούνται δείκτες ποιότητας, γι’ αυτό δεν βαθμολογούνται.'},
  {cite:'Watson, N. F. et al. (2015). Recommended Amount of Sleep for a Healthy Adult: A Joint Consensus Statement of the AASM and SRS. J Clin Sleep Med, 11(6), 591–592.',url:'https://doi.org/10.5664/jcsm.4758',use:'Στόχος διάρκειας: τουλάχιστον 7 ώρες για ενήλικες.'},
  {cite:'Baniassadi, A., Manor, B., Yu, W., Travison, T., & Lipsitz, L. (2023). Nighttime ambient temperature and sleep in community-dwelling older adults. Science of the Total Environment, 899, 165623.',url:'https://doi.org/10.1016/j.scitotenv.2023.165623',use:'Θερμοκρασία: καλύτερος ύπνος στους 20–25 °C (άτομα 65+).'},
  {cite:'Okamoto-Mizuno, K., Mizuno, K., Michie, S., Maeda, A., & Iizuka, S. (1999). Effects of humid heat exposure on human sleep stages and body temperature. Sleep, 22(6), 767–773.',url:'https://pubmed.ncbi.nlm.nih.gov/10505822/',use:'Η υγρή ζέστη αυξάνει την εγρήγορση και μειώνει βαθύ ύπνο και REM.'},
  {cite:'Okamoto-Mizuno, K., Tsuzuki, K., & Mizuno, K. (2005). Effects of humid heat exposure in later sleep segments on sleep stages and body temperature in humans. International Journal of Biometeorology.',url:'https://doi.org/10.1007/s00484-004-0237-z',use:'Η ζέστη αργά τη νύχτα επηρεάζει επίσης τα στάδια.'},
  {cite:'Okamoto-Mizuno, K., Tsuzuki, K., Mizuno, K., & Iwaki, T. (2005). Effects of partial humid heat exposure during different segments of sleep on human sleep stages and body temperature. Physiology & Behavior.',url:'https://doi.org/10.1016/j.physbeh.2004.09.009',use:'Το πότε συμβαίνει η ζέστη μέσα στη νύχτα έχει σημασία.'},
  {cite:'Han, J. M., Estrella Guillén, E., Liu, S., Chen, Y., & Samuelson, H. W. (2025). Using explainable artificial intelligence to predict sleep interruptions from indoor environmental conditions: an empirical study. Building Research & Information, 53(5), 636–655.',url:'https://doi.org/10.1080/09613218.2025.2482959',use:'Ίδια μέθοδος με το «Δωμάτιο και ύπνος»: αισθητήρες στο σπίτι και βραχιόλι, συσχέτιση ανά νύχτα. Οι περισσότερες νύχτες ήταν στους 21–23 °C.'},
];

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
  if(night.environment.coverage<.8) rows.push({type:'data',title:'Πρώτα, μια πλήρης νύχτα μετρήσεων',observation:`Ο αισθητήρας καλύπτει ${Math.round(night.environment.coverage*100)}% του καταγεγραμμένου ύπνου.`,action:'Άφησε τον αισθητήρα, τον υπολογιστή και τη γέφυρα σε λειτουργία. Το σκορ δωματίου εμφανίζεται όταν οι μετρήσεις καλύπτουν τουλάχιστον το 80% του ύπνου.'});
  if(night.asleep_minutes<420) rows.push({type:'sleep',title:'Δώσε χώρο στη διάρκεια',observation:`Το ρολόι κατέγραψε ${minutes(night.asleep_minutes)} ύπνου.`,action:'Για ενήλικες 18–60 ετών, η AASM/SRS συστήνει τουλάχιστον 7 ώρες τακτικά. Εξέτασε αν το πρόγραμμά σου αφήνει αρκετό χρόνο για ύπνο.',source:SOURCES.sleep,sourceName:'Watson et al. 2015'});
  if(night.environment.coverage>=.8&&night.environment.temperature_avg>quality?.ideal.temp_high) rows.push({type:'room',title:'Δοκίμασε ένα πιο δροσερό δωμάτιο',observation:`Μέση θερμοκρασία ${night.environment.temperature_avg.toFixed(1)} °C, πάνω από την επιλεγμένη ζώνη του Thalpos.`,action:'Κάνε μια μικρή, άνετη για εσένα αλλαγή πριν τον ύπνο και σύγκρινε αρκετές νύχτες. Σε μελέτη σε σπίτια, ακόμα και περίπου +1,4 °C συνδέθηκε με πιο ανήσυχο ύπνο.',source:SOURCES.home,sourceName:'Han et al. 2025'});
  if(night.environment.coverage>=.8&&night.environment.humidity_avg>quality?.ideal.hum_high) rows.push({type:'room',title:'Έλεγξε την παρατεταμένη υγρασία',observation:`Μέση υγρασία στον ύπνο ${Math.round(night.environment.humidity_avg)}%.`,action:'Έλεγξε πηγές υγρασίας και κατάλληλο αερισμό ή αφύγρανση. Η EPA προτείνει RH κάτω από 60% για υγρασία και μούχλα. Σε πειράματα, ο συνδυασμός ζέστης και υγρασίας έφερε περισσότερα ξυπνήματα και λιγότερο βαθύ ύπνο.',source:SOURCES.humidity,sourceName:'US EPA'});
  if(night.awake_periods>0) rows.push({type:'sleep',title:'Παρακολούθησε τις αφυπνίσεις σε βάθος χρόνου',observation:`Καταγράφηκαν ${night.awake_periods} διαστήματα αφύπνισης από το ρολόι.`,action:'Δοκίμασε σταθερό ωράριο και ήσυχο, σκοτεινό δωμάτιο. Η καταγραφή δεν αποδεικνύει τι προκάλεσε ένα ξύπνημα και δεν αρκεί για διάγνωση.',source:SOURCES.habits,sourceName:'NIH / NHLBI'});
  rows.push({type:'routine',title:'Κράτησε σταθερή τη ρουτίνα σου',observation:'Η διάρκεια και τα στάδια δεν περιγράφουν από μόνα τους όλη την εμπειρία του ύπνου.',action:'Διατήρησε όσο γίνεται σταθερές ώρες ύπνου και αφύπνισης. Σύγκρινε τις μετρήσεις με το πώς νιώθεις το πρωί, χωρίς να κυνηγάς ένα «τέλειο 100%».',source:SOURCES.habits,sourceName:'NIH / NHLBI'});
  return <section className="sl-card sl-insights"><div className="sl-section-heading"><div><span className="sl-eyebrow">ΜΙΚΡΕΣ ΑΛΛΑΓΕΣ</span><h3>Τι μπορείς να βελτιώσεις</h3></div><Sparkles size={21}/></div>
    <div className="sl-insights__grid">{rows.slice(0,4).map((row,i)=><article key={row.title} className="sl-insight"><span className="sl-insight__number">{String(i+1).padStart(2,'0')}</span><div><h4>{row.title}</h4><p className="sl-insight__observation">{row.observation}</p><p>{row.action}</p>{row.source&&<a href={row.source} target="_blank" rel="noreferrer">{row.sourceName}<ArrowUpRight size={12}/></a>}</div></article>)}</div>
    <p className="sl-fineprint">Οι προτάσεις υποστηρίζουν προσωπική παρατήρηση. Δεν εγγυώνται βελτίωση ή «τέλειο ύπνο». Αν οι δυσκολίες ύπνου επιμένουν ή επηρεάζουν την ημέρα σου, συζήτησέ τες με επαγγελματία υγείας.</p>
  </section>;
}

/** Compact 7-night summary at the top of the page: shows that each measurement is a
 *  trend across the week, not an isolated number, and lets the user click a night. */
function TrendStrip({sessions,selectedId,onPick}) {
  const nights=sessions.slice(0,7).slice().reverse();
  if(nights.length<2) return null;
  const metric=(label,unit,get,color)=>{
    const values=nights.map(get);
    const known=values.filter(v=>v!=null);
    if(!known.length) return null;
    const lo=Math.min(...known),hi=Math.max(...known),span=Math.max(hi-lo,.1);
    const avg=known.reduce((a,b)=>a+b,0)/known.length;
    const latest=values[values.length-1];
    return <div className="sl-trend__metric" key={label}><div className="sl-trend__value"><b>{latest==null?'—':latest.toLocaleString('el-GR',{maximumFractionDigits:1})}<small>{unit}</small></b><span>{label} · μ.ό. 7ν. {avg.toLocaleString('el-GR',{maximumFractionDigits:1})}{unit}</span></div>
      <svg viewBox="0 0 140 36" className="sl-trend__chart" aria-hidden="true">{values.map((v,i)=>{
        const x=8+i*(124/Math.max(nights.length-1,1));
        const y=v==null?30:30-(v-lo)/span*22;
        return <g key={i}>{v==null?<circle cx={x} cy="30" r="2.4" fill="#4a5e75"/>:<circle cx={x} cy={y} r="2.6" fill={color}/>}</g>;
      })}{values.filter(v=>v!=null).length>1&&<polyline fill="none" stroke={color} strokeWidth="1.4" strokeOpacity=".75" points={values.map((v,i)=>v==null?null:`${8+i*(124/Math.max(nights.length-1,1))},${30-(v-lo)/span*22}`).filter(Boolean).join(' ')}/>}</svg>
    </div>;
  };
  const metrics=[
    metric('Ύπνος','ω',s=>s.asleep_minutes?s.asleep_minutes/60:null,'#b5a2f4'),
    metric('Deep %','%',s=>{const t=(s.end-s.start)/60;return t?Math.round((s.stage_minutes.deep||0)/t*100):null;},'#7778ef'),
    metric('Θερμ. ύπνου','°C',s=>s.environment.temperature_avg,'#f5b879'),
    metric('Δωμάτιο','%',s=>s.quality_index?.room_score??null,'#6ed9d1'),
  ].filter(Boolean);
  return <section className="sl-card sl-trend">
    <div className="sl-card__heading"><span className="sl-icon"><TrendingUp size={17}/></span><h3>Οι τελευταίες {nights.length} νύχτες</h3><span className="sl-muted">Πάτα μια κουκίδα για να δεις τη νύχτα</span></div>
    <div className="sl-trend__grid">{metrics}</div>
    <div className="sl-trend__dots" role="tablist" aria-label="Νύχτες">{nights.map(n=><button key={n.id} type="button" role="tab" aria-selected={n.id===selectedId} className={`sl-trend__dot ${n.id===selectedId?'is-active':''}`} onClick={()=>onPick(n.id)} title={new Date(n.end*1000).toLocaleDateString('el-GR',{weekday:'long',day:'numeric',month:'short'})}><span>{new Date(n.end*1000).toLocaleDateString('el-GR',{weekday:'short'}).slice(0,2)}</span><em>{new Date(n.end*1000).getDate()}</em></button>)}</div>
  </section>;
}

const NO_BAND=()=>[null,null];
const X_AXES={temperature:{label:'Θερμοκρασία ύπνου',unit:'°C',get:s=>s.environment.temperature_avg,band:q=>[q.temp_low,q.temp_high],noun:'θερμοκρασία'},
  humidity:{label:'Υγρασία ύπνου',unit:'%',get:s=>s.environment.humidity_avg,band:q=>[q.hum_low,q.hum_high],noun:'υγρασία'},
  temperature_sd:{label:'Αυξομείωση θερμοκρασίας',unit:'°C',get:s=>s.environment.temperature_sd??null,band:NO_BAND,noun:'αυξομείωση της θερμοκρασίας'},
  humidity_sd:{label:'Αυξομείωση υγρασίας',unit:'%',get:s=>s.environment.humidity_sd??null,band:NO_BAND,noun:'αυξομείωση της υγρασίας'}};
const Y_AXES={hours:{label:'Ώρες ύπνου',unit:'ω',get:s=>s.asleep_minutes?s.asleep_minutes/60:null,noun:'ο ύπνος σου'},
  deep:{label:'Βαθύς ύπνος',unit:'%',get:s=>{const t=(s.end-s.start)/60;return t?(s.stage_minutes.deep||0)/t*100:null;},noun:'ο βαθύς ύπνος'},
  rating:{label:'Πώς ξύπνησες',unit:'/5',get:s=>s.rating??null,noun:'η πρωινή σου βαθμολογία',fixed:[1,5]}};
const MIN_NIGHTS=14;

/** Pearson r; null when either axis does not vary. */
function pearson(points) {
  const n=points.length,mx=points.reduce((a,p)=>a+p.x,0)/n,my=points.reduce((a,p)=>a+p.y,0)/n;
  let sxy=0,sxx=0,syy=0;
  for(const p of points){sxy+=(p.x-mx)*(p.y-my);sxx+=(p.x-mx)**2;syy+=(p.y-my)**2;}
  return sxx&&syy?sxy/Math.sqrt(sxx*syy):null;
}

function describe(r,x,y) {
  const size=Math.abs(r);
  if(size<.3) return `Δεν φαίνεται σαφής σχέση ανάμεσα στην ${x.noun} και στο «${y.label.toLowerCase()}» σε αυτές τις νύχτες.`;
  const strength=size<.5?'μέτρια':'ισχυρή';
  return `${strength[0].toUpperCase()+strength.slice(1)} σχέση: όσο ανεβαίνει η ${x.noun}, ${y.noun} τείνει να ${r<0?'μειώνεται':'αυξάνεται'}.`;
}

/** One dot per night with enough room readings. Separate scores stay separate; this is
 *  where their relationship is shown, as in Han et al. (2025). */
function RoomVsSleep({sessions,selectedId,onPick}) {
  const [xKey,setXKey]=useState('temperature'),[yKey,setYKey]=useState('hours');
  const [boxRef,boxWidth]=useElementWidth();
  const x=X_AXES[xKey],y=Y_AXES[yKey];
  const ideal=sessions.find(s=>s.quality_index?.ideal)?.quality_index.ideal;
  const points=sessions.filter(s=>s.environment.coverage>=.8).map(s=>({id:s.id,end:s.end,x:x.get(s),y:y.get(s)})).filter(p=>p.x!=null&&p.y!=null);
  const r=points.length>=MIN_NIGHTS?pearson(points):null;
  // Drawn at the box's real pixel width so labels stay readable on a phone.
  const W=Math.min(Math.max(boxWidth||760,280),900),H=W<500?240:280,L=46,R=12,T=14,B=36;
  const [bandLo,bandHi]=ideal?x.band(ideal):[null,null];
  const xs=points.map(p=>p.x).concat(bandLo??[],bandHi??[]),ys=points.map(p=>p.y);
  const xSpan=x.band===NO_BAND?.2:.5;
  const x0Raw=Math.min(...xs,Infinity)-xSpan,x1Raw=Math.max(...xs,-Infinity)+xSpan;
  const x0=x.band===NO_BAND?Math.max(0,Math.floor(x0Raw*10)/10):Math.floor(x0Raw),x1=x.band===NO_BAND?Math.ceil(x1Raw*10)/10:Math.ceil(x1Raw);
  const [y0,y1]=y.fixed??[Math.max(0,Math.floor(Math.min(...ys,Infinity)-1)),Math.ceil(Math.max(...ys,-Infinity)+1)];
  const px=v=>L+(v-x0)/Math.max(x1-x0,.1)*(W-L-R),py=v=>H-B-(v-y0)/Math.max(y1-y0,1)*(H-T-B);
  const picker=(axes,value,set,label)=><label className="sl-relation__pick">{label}<select value={value} onChange={e=>set(e.target.value)}>{Object.entries(axes).map(([key,axis])=><option key={key} value={key}>{axis.label}</option>)}</select></label>;
  return <section className="sl-card sl-relation">
    <div className="sl-section-heading"><div><span className="sl-eyebrow">ΔΩΜΑΤΙΟ ΚΑΙ ΥΠΝΟΣ</span><h3>Επηρεάζει το δωμάτιο τον ύπνο σου;</h3></div><ScatterChart size={21}/></div>
    <p className="sl-muted">Κάθε κουκίδα είναι μία νύχτα. Τα δύο σκορ μένουν χωριστά και εδώ φαίνεται αν σχετίζονται στις δικές σου νύχτες.</p>
    <div className="sl-relation__controls">{picker(X_AXES,xKey,setXKey,'Δωμάτιο')}<span aria-hidden="true">→</span>{picker(Y_AXES,yKey,setYKey,'Ύπνος')}</div>
    {points.length<2?<p className="sl-relation__empty">{yKey==='rating'?'Βαθμολόγησε πώς ξύπνησες σε τουλάχιστον 2 νύχτες με πλήρεις μετρήσεις δωματίου για να εμφανιστεί το γράφημα.':'Χρειάζονται τουλάχιστον 2 νύχτες με πλήρεις μετρήσεις δωματίου για το γράφημα.'}</p>:<>
      <div className="sl-scatter-box" ref={boxRef}><svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="sl-scatter" role="img" aria-label={`${x.label} και ${y.label}, ${points.length} νύχτες`}>
        {bandLo!=null&&<rect x={px(bandLo)} y={T} width={Math.max(0,px(bandHi)-px(bandLo))} height={H-T-B} className="sl-scatter__band"/>}
        {bandLo!=null&&<text x={(px(bandLo)+px(bandHi))/2} y={T+12} textAnchor="middle" className="sl-scatter__band-label">ιδανική ζώνη {bandLo}–{bandHi}{x.unit}</text>}
        <line x1={L} x2={W-R} y1={H-B} y2={H-B} className="sl-scatter__axis"/><line x1={L} x2={L} y1={T} y2={H-B} className="sl-scatter__axis"/>
        {[x0,(x0+x1)/2,x1].map((v,i)=><text key={`x${v}`} x={px(v)} y={H-B+16} textAnchor={['start','middle','end'][i]} className="sl-scatter__tick">{x.band===NO_BAND?'±':''}{v.toLocaleString('el-GR',{maximumFractionDigits:2})}{x.unit}</text>)}
        {(y.fixed?[1,2,3,4,5]:[y0,(y0+y1)/2,y1]).map(v=><text key={`y${v}`} x={L-6} y={py(v)+3} textAnchor="end" className="sl-scatter__tick">{v.toLocaleString('el-GR',{maximumFractionDigits:1})}{y.unit}</text>)}
        <text x={W-R} y={H-4} textAnchor="end" className="sl-scatter__title">{x.label}</text>
        {points.map(p=><g key={p.id} className={`sl-scatter__dot ${p.id===selectedId?'is-active':''}`} onClick={()=>onPick(p.id)}><circle cx={px(p.x)} cy={py(p.y)} r="9" className="sl-scatter__hit"/><circle cx={px(p.x)} cy={py(p.y)} r={p.id===selectedId?6:4.5}/><title>{new Date(p.end*1000).toLocaleDateString('el-GR',{weekday:'short',day:'numeric',month:'short'})} · {x.band===NO_BAND?'±':''}{p.x.toFixed(x.band===NO_BAND?2:1)}{x.unit} · {y.fixed?p.y:p.y.toFixed(1)}{y.unit}</title></g>)}
      </svg></div>
      <div className="sl-relation__result" role="status">{r==null
        ?<p><b>{points.length} από {MIN_NIGHTS} νύχτες.</b> Μετά τις {MIN_NIGHTS} νύχτες εμφανίζεται εδώ αν υπάρχει σχέση. Με λιγότερες, μια σύμπτωση μοιάζει εύκολα με μοτίβο.</p>
        :<p><b>{describe(r,x,y)}</b> <span className="sl-muted">r = {r.toLocaleString('el-GR',{maximumFractionDigits:2,minimumFractionDigits:2})} σε {points.length} νύχτες.</span></p>}</div>
    </>}
    <p className="sl-fineprint">Η συσχέτιση δεν αποδεικνύει αιτία: η διάρκεια εξαρτάται πολύ από το πρόγραμμά σου, και το ποσοστό βαθύ ύπνου από το ρολόι είναι εκτίμηση. Η αυξομείωση είναι η τυπική απόκλιση μέσα στις ώρες ύπνου. Το σταθερό σφάλμα του αισθητήρα (περίπου +2 °C) μετακινεί όλες τις κουκίδες μαζί και δεν αλλάζει το r. <a href={SOURCES.home} target="_blank" rel="noreferrer">Μέθοδος: Han et al. 2025<ArrowUpRight size={11}/></a></p>
  </section>;
}

const RATING_WORDS={1:'Εξαντλημένος',2:'Κουρασμένος',3:'Έτσι κι έτσι',4:'Ξεκούραστος',5:'Πολύ ξεκούραστος'};

/** One tap each morning: how rested you felt. Subjective quality is part of the NSF
 *  definition (Ohayon et al. 2017), and a better y-axis than duration, which mostly
 *  follows the alarm clock. Tapping the chosen value again clears it. */
function MorningRating({value,onRate,disabled}) {
  return <section className="sl-card sl-morning">
    <div><h3>Πώς ξύπνησες;</h3><p className="sl-muted">{value?RATING_WORDS[value]:'Ένα πάτημα, όσο το θυμάσαι. Πάτα ξανά για να το σβήσεις.'}</p></div>
    <div className="sl-morning__scale" role="radiogroup" aria-label="Πώς ξύπνησες, 1 έως 5">
      {[1,2,3,4,5].map(n=><button key={n} type="button" role="radio" aria-checked={value===n} aria-label={`${n}: ${RATING_WORDS[n]}`} title={RATING_WORDS[n]} className={value===n?'is-active':''} disabled={disabled} onClick={()=>onRate(value===n?null:n)}>{n}</button>)}
      <span aria-hidden="true">κουρασμένος</span><span aria-hidden="true">ξεκούραστος</span>
    </div>
  </section>;
}

/** The wearable may not report any awake interval at all (Mi Fitness/Xiaomi default). The
 *  continuity component then becomes "not reported" instead of a misleading 100 %. */
function AwakeMissingNote() {
  return <div className="sl-data-note" role="status"><AlertCircle size={16}/><span>Το ρολόι δεν αναφέρει καθόλου αφυπνίσεις σε αυτή τη νύχτα. Το σκορ ύπνου υπολογίζεται μόνο από τη διάρκεια, όχι από συνέχεια που θα ήταν πάντα 100 %. Ενεργοποίησε «Λεπτομερή παρακολούθηση ύπνου» στο Mi Fitness αν θέλεις να καταγράφονται και οι ώρες ξύπνιου.</span></div>;
}

export default function WearableSleep({room}) {
  const [token,setToken]=useState(()=>sessionStorage.getItem('thalpos-sleep-key')||'');
  const [activeToken,setActiveToken]=useState(()=>sessionStorage.getItem('thalpos-sleep-key')||'');
  const [refreshId,setRefreshId]=useState(0),[targetHours,setTargetHours]=useState(8),[picked,setPicked]=useState('');
  const {data,error:loadError,loading,refreshed}=useWearableSessions(room,activeToken,refreshId,targetHours);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[ratings,setRatings]=useState({});
  // A tap shows at once; the next refresh confirms it from the bridge.
  const sessions=data?.sessions.map(s=>s.night in ratings?{...s,rating:ratings[s.night]}:s);
  const night=sessions?.find(s=>s.id===picked)||sessions?.[0];
  const quality=night?.quality_index;
  function unlock(){if(DEMO){setError('Τα προσωπικά δεδομένα δεν εμφανίζονται στο demo.');return;}sessionStorage.setItem('thalpos-sleep-key',token.trim());setActiveToken(token.trim());setRefreshId(v=>v+1);setError('');}
  function lock(){sessionStorage.removeItem('thalpos-sleep-key');setToken('');setActiveToken('');setPicked('');setError('');}
  async function rate(value){
    const key=night.night,previous=night.rating??null;
    setRatings(r=>({...r,[key]:value}));setError('');
    try{const response=await fetch('/wearable/ratings',{method:'PUT',headers:{Authorization:`Bearer ${activeToken}`,'Content-Type':'application/json'},body:JSON.stringify({room,night:key,rating:value}),signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error('Η βαθμολογία δεν αποθηκεύτηκε. Δοκίμασε ξανά.');}
    catch(e){setRatings(r=>({...r,[key]:previous}));setError(e.message);}
  }
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
      <TrendStrip sessions={sessions} selectedId={night.id} onPick={setPicked}/>
      <div className="sl-night-heading"><div><span className="sl-eyebrow">Η ΑΝΑΣΚΟΠΗΣΗ ΣΟΥ</span><h2>{nightOf(night.end)}</h2><p><Moon size={14}/>{clock(night.start)} — {clock(night.end)}<span>·</span>{night.room}<span>·</span>Mi Fitness</p></div><label className="sl-select-label">Επιλογή νύχτας<select aria-label="Sleep session" value={night.id} onChange={e=>setPicked(e.target.value)}>{sessions.map(s=><option key={s.id} value={s.id}>{new Date(s.end*1000).toLocaleDateString('el-GR')} · {clock(s.start)}–{clock(s.end)}</option>)}</select></label></div>
      {night.night&&<MorningRating value={night.rating??null} onRate={rate} disabled={busy}/>}
      <div className="sl-overview">
        <Metric icon={Watch} title="Ύπνος" value={pct(quality?.sleep_score)} detail={quality?.sleep_score==null?'Το ρολόι δεν κάλυψε αρκετό μέρος της νύχτας με στάδια.':`Διάρκεια σε σχέση με τον στόχο των ${targetHours} ωρών`} tone="violet"><div className="sl-facts"><div><span>Διάρκεια</span><b>{minutes(night.asleep_minutes)}</b></div><div><span>Αφυπνίσεις</span><b>{quality?.has_awake_stages===false?'—':night.awake_periods}</b></div></div><label className="sl-target">Προσωπικός στόχος<select aria-label="Personal sleep duration target" value={targetHours} onChange={e=>setTargetHours(Number(e.target.value))}>{Array.from({length:17},(_,i)=>4+i*.5).map(h=><option key={h} value={h}>{h} ώρες</option>)}</select></label></Metric>
        <Metric icon={Thermometer} title="Δωμάτιο" value={pct(quality?.room_score)} detail={`Ζώνη ${quality?.ideal.temp_low}–${quality?.ideal.temp_high} °C και ${quality?.ideal.hum_low}–${quality?.ideal.hum_high}%, μόνο στις ώρες ύπνου`} tone="mint"><div className="sl-environment"><div><Thermometer size={17}/><b>{night.environment.temperature_avg==null?'—':night.environment.temperature_avg.toFixed(1)}<small>°C</small></b><span>Θερμοκρασία{night.environment.temperature_sd!=null&&<em> · ±{night.environment.temperature_sd.toLocaleString('el-GR',{maximumFractionDigits:1})} °C</em>}</span></div><div><Droplets size={17}/><b>{night.environment.humidity_avg==null?'—':Math.round(night.environment.humidity_avg)}<small>%</small></b><span>Υγρασία{night.environment.humidity_sd!=null&&<em> · ±{night.environment.humidity_sd.toLocaleString('el-GR',{maximumFractionDigits:1})}%</em>}</span></div></div><div className="sl-coverage"><span>Κάλυψη αισθητήρα <b>{Math.round(night.environment.coverage*100)}%</b></span><div><i style={{width:`${night.environment.coverage*100}%`}}/></div></div></Metric>
      </div>
      <section className="sl-card sl-stages"><div className="sl-section-heading"><div><span className="sl-eyebrow">Η ΣΥΝΘΕΣΗ ΤΗΣ ΝΥΧΤΑΣ</span><h3>Στάδια ύπνου</h3></div><span className="sl-muted">Εκτιμήσεις ρολογιού</span></div><div className="sl-stage-strip" aria-hidden="true">{night.stages.map((s,i)=><span key={i} style={{width:`${(s.end-s.start)/(night.end-night.start)*100}%`,background:colors[s.stage]}}/>)}</div><div className="sl-stage-facts">{['deep','light','rem','awake'].map(key=><div key={key}><span><i style={{background:colors[key]}}/>{names[key]}</span><b>{minutes(night.stage_minutes[key])}</b><small>{Math.round((night.stage_minutes[key]||0)/((night.end-night.start)/60)*100)}% της συνεδρίας</small></div>)}</div></section>
      {quality?.has_awake_stages===false&&<AwakeMissingNote/>}
      {night.overlap_warning&&<div className="sl-data-note" role="status"><Info size={16}/><span>Υπάρχουν επικαλυπτόμενες εγγραφές. Εμφανίζεται η πιο πρόσφατη εκδοχή, χωρίς διπλή πρόσθεση χρόνου. Σύγκρινέ τη με το Mi Fitness.</span></div>}
      <section className="sl-card sl-chart-card"><div className="sl-section-heading"><div><span className="sl-eyebrow">ΣΤΗΝ ΙΔΙΑ ΧΡΟΝΟΓΡΑΜΜΗ</span><h3>Ύπνος και συνθήκες δωματίου</h3></div><span className="sl-tag">Μόνο ώρες ύπνου</span></div><p className="sl-muted">Θερμοκρασία και υγρασία παραμένουν κενές στις αφυπνίσεις και στα διαστήματα χωρίς μετρήσεις.</p><div className="sl-chart-scroll"><AlignedNight night={night}/></div><p className="sl-swipe">Σύρε οριζόντια για να δεις όλη τη νύχτα →</p></section>
      <RoomVsSleep sessions={sessions} selectedId={night.id} onPick={setPicked}/>
      <Insights night={night}/>
      <details className="sl-card sl-method"><summary><Info size={17}/>Πώς υπολογίζονται τα σκορ</summary>
        <p><b>Γιατί δύο σκορ και όχι ένα.</b> Το ρολόι μετράει τον ύπνο (το αποτέλεσμα). Ο αισθητήρας μετράει το δωμάτιο (μια πιθανή αιτία). Καμία μελέτη δεν ορίζει βάρος για να ενωθούν, και ένας κοινός αριθμός θα άφηνε ένα καλό δωμάτιο να κρύψει μια κοντή νύχτα. Η σχέση τους φαίνεται στο «Δωμάτιο και ύπνος», όπως στους Han et al. (2025).</p>
        <p><b>Ύπνος.</b> Διάρκεια ύπνου σε σχέση με τον προσωπικό στόχο (Watson et al. 2015: τουλάχιστον 7 ώρες). Αν το ρολόι αναφέρει αφυπνίσεις, μπαίνει και η συνέχεια του ύπνου στον μέσο όρο. Το Mi Fitness συνήθως δεν τις αναφέρει, οπότε το σκορ είναι μόνο η διάρκεια. Το βαθύ και το REM εμφανίζονται αλλά δεν βαθμολογούνται: η NSF (Ohayon et al. 2017) δεν τα δέχτηκε ως δείκτες ποιότητας, και τα ρολόγια τα εκτιμούν μέτρια. Απαιτούνται γνωστά στάδια για τουλάχιστον 90% της συνεδρίας.</p>
        <p><b>Δωμάτιο.</b> Ζώνες {quality?.ideal.temp_low}–{quality?.ideal.temp_high} °C (Baniassadi et al. 2023, Han et al. 2025) και {quality?.ideal.hum_low}–{quality?.ideal.hum_high}% RH (EPA, Okamoto-Mizuno et al.). Μετράνε μόνο οι ώρες που το ρολόι κατέγραψε ύπνο. Από το 100 αφαιρούνται έως 50 μονάδες για θερμοκρασία (10 ανά °C εκτός ζώνης) και έως 50 για υγρασία (2,5 ανά μονάδα RH). Απαιτείται κάλυψη τουλάχιστον 80% του ύπνου. Το «±» δίπλα στη θερμοκρασία και την υγρασία είναι η αυξομείωση μέσα στη νύχτα (τυπική απόκλιση στις ώρες ύπνου). Οι Han et al. (2025) βρήκαν ότι μετράνε και οι διακυμάνσεις, όχι μόνο ο μέσος όρος. Δεν μπαίνει στο σκορ, φαίνεται στο «Δωμάτιο και ύπνος».</p>
        <p><b>Πώς ξύπνησες.</b> Η δική σου βαθμολογία 1–5 κάθε πρωί. Η NSF (Ohayon et al. 2017) ορίζει την ποιότητα ύπνου και από το πώς τη βιώνεις, όχι μόνο από μετρήσεις. Δεν μπαίνει στο σκορ ύπνου. Χρησιμοποιείται ως μέτρηση στο «Δωμάτιο και ύπνος». Αποθηκεύεται μόνο στη γέφυρα του υπολογιστή σου και σβήνει μαζί με τις εισαγωγές.</p>
        <p>Δεν είναι ο βαθμός της Xiaomi ούτε ιατρική αξιολόγηση.</p>
        <p className="sl-fineprint">Σημ.: ο αισθητήρας δείχνει περίπου 2 °C πάνω από την πραγματική θερμοκρασία λόγω της ζέστης της πλακέτας. Μέχρι να μπει διόρθωση (offset), το σκορ δωματίου είναι λίγο αυστηρότερο από το πραγματικό.</p>
        {night.unclassified_minutes>0&&<p>Άγνωστα διαστήματα: {minutes(night.unclassified_minutes)}. Δεν συμπληρώνονται με υποθετικά στάδια.</p>}
        <div className="sl-refs"><h4><BookOpen size={14}/>Πηγές</h4><ol>{REFERENCES.map(ref=><li key={ref.url}><a href={ref.url} target="_blank" rel="noreferrer">{ref.cite}<ArrowUpRight size={11}/></a><span>{ref.use}</span></li>)}</ol></div>
      </details>
    </>}
  </section>;
}
