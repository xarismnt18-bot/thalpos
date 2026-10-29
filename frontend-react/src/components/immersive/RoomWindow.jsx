/** Schematic window on the live room's north exterior wall; manual state only. */
export default function RoomWindow({state='unknown'}) {
  const open=state==='open',color=state==='unknown'?'#718096':open?'#6ee7df':'#55a5d6';
  const bar=(position,args,key)=><mesh key={key} position={position}><boxGeometry args={args}/><meshBasicMaterial color={color}/></mesh>;
  return <group name={`manual-window-${state}`} position={[-2.6,.95,-4.18]}>
    {bar([0,.4,0],[1.5,.055,.07],'top')}{bar([0,-.4,0],[1.5,.055,.07],'bottom')}
    {bar([-.73,0,0],[.055,.8,.07],'left')}{bar([.73,0,0],[.055,.8,.07],'right')}
    <group position={[-.7,0,-.05]} rotation={[0,open?-1.05:0,0]}>
      <mesh position={[.7,0,0]}><boxGeometry args={[1.38,.72,.035]}/><meshBasicMaterial color={color} transparent opacity={open?.4:.22} depthWrite={false}/></mesh>
      {bar([.7,.36,0],[1.4,.04,.045],'leaf-top')}{bar([.7,-.36,0],[1.4,.04,.045],'leaf-bottom')}
      {bar([1.38,0,0],[.04,.72,.045],'leaf-side')}
    </group>
    {open&&[-.35,0,.35].map((x,i)=><group key={x} position={[x,0,-.6-i*.12]} rotation={[-Math.PI/2,0,0]}><mesh><coneGeometry args={[.07,.24,6]}/><meshBasicMaterial color="#6ee7df"/></mesh></group>)}
  </group>;
}
