import { Suspense, useEffect, useMemo, useRef } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { Bloom, EffectComposer } from "@react-three/postprocessing";
import { OptionalBoundary } from "../ui/OptionalBoundary";
import { homeView, roomView, ROOMS } from "./layout";
import { Apartment, CameraDirector, Ground, LiveRoomEffects, RoomTags, SensorPulse } from "./SceneParts";
import RoomWindow from "./RoomWindow";
import { Presence } from "./Presence";

const START = [34, 30, 38]; // far away; the intro flight swoops in from here

/**
 * Phones: the room card covers the top of the canvas and the view buttons the
 * bottom, so shift the projection centre into the free band between them
 * (the canvas still fills the screen; only the 3D framing moves).
 */
const CONTENT_SHARE = 0.31; // measured at the phone home view (layout.js)

function BandFraming({ enabled }) {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const gl = useThree((s) => s.gl);
  const invalidate = useThree((s) => s.invalidate);

  useEffect(() => {
    const apply = () => {
      const canvas = gl.domElement.getBoundingClientRect();
      const top = document.querySelector(".imm-left")?.getBoundingClientRect().bottom;
      const bottom = document.querySelector(".imm-bottom")?.getBoundingClientRect().top;
      if (!enabled || top == null || bottom == null || bottom <= top) {
        camera.clearViewOffset();
      } else {
        const { width: w, height: h } = size;
        const center = (top + bottom) / 2 - canvas.top;
        // the house takes about CONTENT_SHARE of the canvas height; zoom out
        // on short screens so they fit in the band with some margin
        const scale = Math.min(1, (0.85 * (bottom - top)) / (CONTENT_SHARE * h));
        camera.setViewOffset(w * scale, h * scale, (w * scale - w) / 2, (h * scale) / 2 - center, w, h);
      }
      camera.updateProjectionMatrix();
      invalidate();
    };
    apply();
    const observer = new ResizeObserver(apply);
    document.querySelectorAll(".imm-left, .imm-bottom").forEach((el) => observer.observe(el));
    return () => {
      observer.disconnect();
      camera.clearViewOffset();
      camera.updateProjectionMatrix();
    };
  }, [enabled, camera, size, gl, invalidate]);

  return null;
}

/**
 * Full-bleed 3D home. `liveColor` is null when the sensor has no data,
 * which renders the live room grey with no heat / particles. `presence` shows
 * a hologram in the live room while the radar sees someone.
 */
export default function ImmersiveScene({
  liveName, liveColor, liveText, view, focus, selected, onSelect, alert, packetSeq, status, reduced, narrow, presence, presenceSince, windowState, active=true,
}) {
  const controls = useRef();
  const camView = useMemo(() => {
    const room = ROOMS.find((r) => r.id === focus);
    return room ? roomView(room, narrow) : homeView(narrow);
  }, [focus, narrow]);

  return (
    <Canvas
      className="imm-canvas"
      dpr={[1, 2]}
      frameloop={!active ? "never" : reduced ? "demand" : "always"}
      camera={{ fov: 38, near: 0.1, far: 200, position: reduced ? camView.position.toArray() : START }}
      aria-label="3D model of the home. Drag to orbit, scroll to zoom, click a room to focus it."
    >
      <color attach="background" args={["#04070C"]} />
      <fog attach="fog" args={["#04070C", narrow ? 50 : 30, narrow ? 90 : 62]} />
      <hemisphereLight args={["#7FB8E6", "#05080C", 0.55]} />
      <directionalLight position={[-10, 18, 8]} intensity={0.7} color="#BFD9F2" />

      <Ground reduced={reduced} />
      <Apartment liveColor={liveColor} alert={Boolean(alert)} reduced={reduced} selected={selected} onSelect={onSelect} xray={view === "xray"} />
      {liveColor && <LiveRoomEffects color={liveColor} view={view} alert={alert} reduced={reduced} />}
      <RoomWindow state={windowState} />
      <Presence present={Boolean(presence)} since={presenceSince} reduced={reduced} />
      <SensorPulse packetSeq={packetSeq} status={status} reduced={reduced} />
      <RoomTags liveName={liveName} liveText={liveText} liveHasData={Boolean(liveColor)} alert={Boolean(alert)} selected={selected} />

      <OrbitControls
        ref={controls}
        makeDefault
        enableDamping={!reduced}
        dampingFactor={0.06}
        minDistance={9}
        maxDistance={60}
        maxPolarAngle={1.32}
        autoRotate={!reduced && focus === "home"}
        autoRotateSpeed={0.35}
      />
      <CameraDirector view={camView} controls={controls} reduced={reduced} />
      <BandFraming enabled={narrow} />

      <OptionalBoundary>
        <Suspense fallback={null}>
          <EffectComposer multisampling={0}>
            <Bloom mipmapBlur intensity={0.9} luminanceThreshold={0.18} luminanceSmoothing={0.2} />
          </EffectComposer>
        </Suspense>
      </OptionalBoundary>
    </Canvas>
  );
}
