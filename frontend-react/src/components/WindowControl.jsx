/** Window position, entered by hand (no window sensor). One compact row; the "please
 *  confirm" nudge lives only here, not again in the weather card. */
export default function WindowControl({windowState}) {
  const {data,error,busy,declare,disabled}=windowState;
  const label=data?.state==='open'?'Open':data?.state==='closed'?'Closed':'Not set';
  const elapsed=data?.since?Math.max(0,Math.floor(((data.server_now??data.updated)-data.since)/60)):0;
  const stale=data?.needs_confirmation;
  const ago=elapsed>=120?`${Math.floor(elapsed/60)} h`:`${elapsed} min`;
  return <section className={`window-control ${stale?'is-stale':''}`} aria-label="Window position, entered by hand">
    <p className="window-control__state" role="status">
      <strong>Window</strong>
      <span>{label}{data?.state&&` · ${ago}`}{stale&&<em> · still?</em>}</span>
    </p>
    <div className="window-control__buttons">
      <button type="button" disabled={disabled} aria-pressed={data?.state==='open'} onClick={()=>declare(true)}>Open</button>
      <button type="button" disabled={disabled} aria-pressed={data?.state==='closed'} onClick={()=>declare(false)}>Closed</button>
    </div>
    {busy&&<small>Saving…</small>}{error&&<p className="window-control__error" role="alert">{error}</p>}
  </section>;
}
