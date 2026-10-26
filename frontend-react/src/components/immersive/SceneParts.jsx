import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Edges, Html, Line } from "@react-three/drei";
import * as THREE from "three";
import {
  AI_POS, BROKER_POS, DATA_LEGS, FURNITURE, HEAT_INSET, LIVE_ROOM, ROOMS, SENSOR_POS, WALLS, WALL_HEIGHT,
} from "./layout";

const NO_DATA = new THREE.Color("#2A3440");
const easeOut = (x) => 1 - Math.pow(1 - x, 3);

/* ---------- ground: grid + scanning ring ---------- */
const groundVertex = `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`;
const groundFragment = `
  uniform float uTime; uniform vec3 uColor; varying vec3 vP;
  void main(){
    vec2 p = vP.xy; float r = length(p);
    vec2 g = abs(fract(p) - .5);
    float grid = 1. - smoothstep(0., .03, min(g.x, g.y));
    float fade = 1. - smoothstep(4., 16., r);
    float ring = smoothstep(.35, 0., abs(r - mod(uTime * 2.2, 18.)));
    float edge = smoothstep(.08, 0., abs(r - 15.));
    gl_FragColor = vec4(uColor, (grid * .16 + ring * .35) * fade + edge * .25);
  }`;

export function Ground({ reduced }) {
  const mat = useRef();
  const uniforms = useMemo(() => ({ uTime: { value: 0 }, uColor: { value: new THREE.Color("#38BDF8") } }), []);
  useFrame(({ clock }) => {
    if (!reduced && mat.current) mat.current.uniforms.uTime.value = clock.elapsedTime;
  });
  return (
    <mesh rotation-x={-Math.PI / 2} position-y={-0.01}>
      <circleGeometry args={[16, 96]} />
      <shaderMaterial ref={mat} transparent depthWrite={false} uniforms={uniforms} vertexShader={groundVertex} fragmentShader={groundFragment} />
    </mesh>
  );
}

/* ---------- the apartment ---------- */
function Floor({ room, color, selected, onSelect, pulse, reduced }) {
  const mat = useRef();
  const live = room.live && color;
  useFrame(({ clock }) => {
    if (!pulse || reduced || !mat.current) return;
    mat.current.emissiveIntensity = 0.3 + 0.35 * (0.5 + 0.5 * Math.sin(clock.elapsedTime * 2.6));
  });
  const base = live ? color.clone().multiplyScalar(0.35) : selected ? "#10283A" : "#121A23";
  const emissive = live ? color : selected ? "#0E4C70" : "#000000";
  const edge = live ? color : selected ? "#38BDF8" : room.live ? "#3A4654" : "#1C2C3B";
  return (
    <mesh
      position={[room.center.x, 0.03, room.center.z]}
      onClick={(e) => {
        if (e.delta > 5) return; // a drag, not a click
        e.stopPropagation();
        onSelect(room.id);
      }}
      onPointerOver={() => { document.body.style.cursor = "pointer"; }}
      onPointerOut={() => { document.body.style.cursor = ""; }}
    >
      <boxGeometry args={[room.width - 0.06, 0.06, room.depth - 0.06]} />
      <meshStandardMaterial ref={mat} color={base} emissive={emissive} emissiveIntensity={live ? (pulse ? 0.5 : 0.32) : selected ? 0.6 : 0} roughness={0.85} metalness={0.1} />
      <Edges color={edge} />
    </mesh>
  );
}

function Wall({ wall, xray }) {
  const [x1, z1, x2, z2] = wall;
  const len = Math.hypot(x2 - x1, z2 - z1);
  return (
    <mesh position={[(x1 + x2) / 2, WALL_HEIGHT / 2, (z1 + z2) / 2]} rotation-y={-Math.atan2(z2 - z1, x2 - x1)} raycast={() => null}>
      <boxGeometry args={[len, WALL_HEIGHT, 0.12]} />
      <meshStandardMaterial color="#0D1823" transparent opacity={xray ? 0.06 : 0.55} roughness={0.6} depthWrite={!xray} />
      <Edges color={xray ? "#5CC8FF" : "#2E5573"} />
    </mesh>
  );
}

export function Apartment({ liveColor, alert, reduced, selected, onSelect, xray }) {
  return (
    <group>
      {ROOMS.map((room) => (
        <Floor key={room.id} room={room} color={room.live ? liveColor : null} selected={selected === room.id} onSelect={onSelect}
          pulse={room.live && alert && Boolean(liveColor)} reduced={reduced} />
      ))}
      {WALLS.map((w) => <Wall key={w.join()} wall={w} xray={xray} />)}
      {FURNITURE.map(([w, h, d, x, z, y0]) => (
        <mesh key={`${x},${z},${y0}`} position={[x, y0 + h / 2, z]} raycast={() => null}>
          <boxGeometry args={[w, h, d]} />
          <meshStandardMaterial color="#1A2733" roughness={0.7} />
          <Edges color={xray ? "#4FB3E8" : "#2B4257"} />
        </mesh>
      ))}
    </group>
  );
}

/* ---------- live room: heat volume, humidity particles, alert beacon ---------- */
const heatVertex = `varying float vH; varying vec3 vN; varying vec3 vV;
  void main(){ vH = position.y / 1.4 + .5; vN = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`;
const heatFragment = `uniform float uTime; uniform vec3 uColor; uniform float uAmp; varying float vH; varying vec3 vN; varying vec3 vV;
  void main(){
    float fres = pow(1. - abs(dot(vN, vV)), 2.);
    float pulse = .85 + .15 * sin(uTime * 1.8);
    gl_FragColor = vec4(uColor, (.06 + .22 * vH + .25 * fres) * pulse * uAmp);
  }`;

const PARTICLES = 320;
const particleSeed = (() => {
  const pos = new Float32Array(PARTICLES * 3);
  const speed = new Float32Array(PARTICLES);
  for (let i = 0; i < PARTICLES; i++) {
    pos[i * 3] = THREE.MathUtils.randFloat(LIVE_ROOM.x[0] + 0.2, LIVE_ROOM.x[1] - 0.2);
    pos[i * 3 + 1] = Math.random() * 1.6;
    pos[i * 3 + 2] = THREE.MathUtils.randFloat(LIVE_ROOM.z[0] + 0.2, LIVE_ROOM.z[1] - 0.2);
    speed[i] = 0.08 + Math.random() * 0.18;
  }
  return { pos, speed };
})();

export function LiveRoomEffects({ color, view, alert, reduced }) {
  const heat = useRef();
  const points = useRef();
  const beacon = useRef();
  const uniforms = useMemo(() => ({ uTime: { value: 0 }, uColor: { value: new THREE.Color() }, uAmp: { value: 1 } }), []);
  const c = LIVE_ROOM.center;

  useFrame(({ clock }, dt) => {
    const t = clock.elapsedTime;
    if (heat.current) {
      heat.current.uniforms.uColor.value.copy(color);
      heat.current.uniforms.uAmp.value = view === "xray" ? 0.35 : 1;
      if (!reduced) heat.current.uniforms.uTime.value = t;
    }
    if (reduced) return;
    const attr = points.current?.geometry.attributes.position;
    if (attr) {
      const arr = attr.array;
      const step = Math.min(dt, 0.05);
      for (let i = 0; i < PARTICLES; i++) {
        arr[i * 3 + 1] += particleSeed.speed[i] * step;
        arr[i * 3] += Math.sin(t * 0.8 + i) * 0.002;
        if (arr[i * 3 + 1] > 1.7) arr[i * 3 + 1] = 0;
      }
      attr.needsUpdate = true;
    }
    if (beacon.current) beacon.current.opacity = 0.03 + 0.05 * (0.5 + 0.5 * Math.sin(t * 3));
  });

  return (
    <group>
      {/* bottom at 0.1 m: clear of the floor slab's top (0.06 m) so the two don't z-fight */}
      <mesh position={[c.x, 0.8, c.z]} raycast={() => null}>
        <boxGeometry args={[LIVE_ROOM.width - 2 * HEAT_INSET, 1.4, LIVE_ROOM.depth - 2 * HEAT_INSET]} />
        <shaderMaterial ref={heat} transparent depthWrite={false} blending={THREE.AdditiveBlending} side={THREE.DoubleSide}
          uniforms={uniforms} vertexShader={heatVertex} fragmentShader={heatFragment} />
      </mesh>
      <pointLight position={[c.x, 2.2, c.z]} color={color} intensity={6} distance={9} decay={1.6} />
      <points ref={points} raycast={() => null}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[particleSeed.pos, 3]} />
        </bufferGeometry>
        <pointsMaterial color="#9BE7FF" size={view === "hum" ? 0.1 : 0.07} transparent depthWrite={false}
          opacity={view === "hum" ? 1 : view === "xray" ? 0.3 : 0.55} blending={THREE.AdditiveBlending} />
      </points>
      {alert && (
        <mesh position={[c.x, 4.5, c.z]} raycast={() => null}>
          <cylinderGeometry args={[0.02, 0.1, 5, 16, 1, true]} />
          <meshBasicMaterial ref={beacon} color="#EF4444" transparent opacity={0.05}
            blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      )}
    </group>
  );
}

/* ---------- data path: sensor -> MQTT broker -> AI engine ---------- */
function Orb({ position, color, radius, label, online, reduced }) {
  const shell = useRef();
  useFrame((_, dt) => {
    if (reduced || !shell.current) return;
    shell.current.rotation.y += dt * 0.5;
    shell.current.rotation.x += dt * 0.2;
  });
  const tint = online ? color : "#3A4654";
  return (
    <group position={position}>
      <mesh><sphereGeometry args={[radius * 0.45, 24, 24]} /><meshBasicMaterial color={tint} /></mesh>
      <mesh ref={shell}><icosahedronGeometry args={[radius, 1]} /><meshBasicMaterial color={tint} wireframe transparent opacity={0.55} /></mesh>
      <Html position={[0, radius + 0.6, 0]} center zIndexRange={[10, 0]} className="imm-tag-wrap">
        <div className={`imm-tag imm-tag--sys ${online ? "" : "imm-tag--off"}`}>{label}{online ? "" : " · offline"}</div>
      </Html>
    </group>
  );
}

const TRAIL = 6;
const FLIGHT_MS = 1600;

export function DataPath({ packetSeq, status, reduced }) {
  const packets = useRef([]);
  const ripple = useRef();
  const startedAt = useRef(null);
  const legPoints = useMemo(() => DATA_LEGS.map((leg) => leg.getPoints(60)), []);

  useEffect(() => {
    if (packetSeq > 0 && !reduced) startedAt.current = performance.now();
  }, [packetSeq, reduced]);

  useFrame(() => {
    const t0 = startedAt.current;
    const k = t0 == null ? 2 : (performance.now() - t0) / FLIGHT_MS;
    packets.current.forEach((m, i) => {
      if (!m) return;
      const kk = k - i * 0.025;
      m.visible = kk >= 0 && kk <= 1;
      if (!m.visible) return;
      const first = kk < 0.55;
      const local = first ? kk / 0.55 : (kk - 0.55) / 0.45;
      m.position.copy(DATA_LEGS[first ? 0 : 1].getPoint(easeOut(local)));
    });
    if (ripple.current) {
      const r = k * (FLIGHT_MS / 1200);
      const on = r < 1;
      ripple.current.visible = on;
      if (on) {
        ripple.current.scale.setScalar(1 + r * 14);
        ripple.current.material.opacity = 0.3 * (1 - r);
      }
    }
  });

  return (
    <group>
      <mesh position={SENSOR_POS}>
        <sphereGeometry args={[0.13, 20, 20]} />
        <meshBasicMaterial color={status.sensor ? "#7DD3FC" : "#3A4654"} />
      </mesh>
      <Orb position={BROKER_POS} color="#38BDF8" radius={0.55} label="MQTT broker" online={status.broker} reduced={reduced} />
      <Orb position={AI_POS} color="#A78BFA" radius={0.7} label="AI engine" online={status.api} reduced={reduced} />
      {legPoints.map((pts, i) => (
        <Line key={i} points={pts} color="#38BDF8" lineWidth={1} dashed dashSize={0.18} gapSize={0.14} transparent opacity={0.35} />
      ))}
      {Array.from({ length: TRAIL }, (_, i) => (
        <mesh key={i} ref={(m) => { packets.current[i] = m; }} visible={false}>
          <sphereGeometry args={[0.14 * (1 - (i / TRAIL) * 0.7), 12, 12]} />
          <meshBasicMaterial color="#BAE6FD" transparent opacity={1 - i / TRAIL} />
        </mesh>
      ))}
      <mesh ref={ripple} rotation-x={-Math.PI / 2} position={[-2.2, 0.08, -0.8]} visible={false}>
        <ringGeometry args={[0.2, 0.28, 48]} />
        <meshBasicMaterial color="#7DD3FC" transparent opacity={0} side={THREE.DoubleSide} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
    </group>
  );
}

/* ---------- room labels anchored in 3D ---------- */
export function RoomTags({ liveName, liveText, liveHasData, alert }) {
  return ROOMS.map((room) => (
    <Html key={room.id} position={[room.center.x, room.live ? 2.3 : 1.7, room.center.z]} center zIndexRange={[10, 0]} className="imm-tag-wrap">
      {room.live ? (
        <div className={`imm-tag ${liveHasData ? "imm-tag--live" : ""} ${liveHasData && alert ? "imm-tag--alert" : ""}`}>{liveName} <span className="num">{liveText}</span></div>
      ) : (
        <div className="imm-tag imm-tag--idle">{room.name}</div>
      )}
    </Html>
  ));
}

/* ---------- camera: intro swoop, then fly to the focused room ---------- */
export function CameraDirector({ view, controls, reduced }) {
  const { camera, invalidate } = useThree();
  const flight = useRef(null);

  useEffect(() => {
    flight.current = {
      t0: performance.now(),
      dur: reduced ? 0 : (flight.current ? 1400 : 2600), // first flight = intro
      fromP: camera.position.clone(),
      fromT: controls.current ? controls.current.target.clone() : view.target.clone(),
      toP: view.position.clone(),
      toT: view.target.clone(),
    };
    invalidate();
  }, [view, camera, controls, reduced, invalidate]);

  useFrame(() => {
    const f = flight.current;
    if (!f || f.done) return;
    const k = f.dur ? Math.min(1, (performance.now() - f.t0) / f.dur) : 1;
    const e = easeOut(k);
    camera.position.lerpVectors(f.fromP, f.toP, e);
    controls.current?.target.lerpVectors(f.fromT, f.toT, e);
    controls.current?.update();
    if (k >= 1) f.done = true;
    else invalidate();
  });
  return null;
}

export { NO_DATA };
