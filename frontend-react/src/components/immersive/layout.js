import * as THREE from "three";

// Apartment geometry in metres (x = east, z = south). The first room is the one
// with the live DHT11; it takes the display name from settings / the backend.
export const LIVE_ROOM_ID = "live";
export const WALL_HEIGHT = 1.5;

export const ROOMS = [
  { id: LIVE_ROOM_ID, name: null, x: [-6, -1], z: [-4, 0], live: true },
  { id: "bath", name: "Bathroom", x: [-1, 1.5], z: [-4, 0] },
  { id: "kitchen", name: "Kitchen", x: [1.5, 6], z: [-4, 0] },
  { id: "living", name: "Living room", x: [-6, 2], z: [0, 4] },
  { id: "office", name: "Office", x: [2, 6], z: [0, 4] },
].map((r) => ({
  ...r,
  width: r.x[1] - r.x[0],
  depth: r.z[1] - r.z[0],
  center: new THREE.Vector3((r.x[0] + r.x[1]) / 2, 0, (r.z[0] + r.z[1]) / 2),
}));

export const LIVE_ROOM = ROOMS[0];

// [x1, z1, x2, z2]; gaps are doorways
export const WALLS = [
  [-6, -4, 6, -4], [6, -4, 6, 4], [6, 4, -6, 4], [-6, 4, -6, -4],
  [-6, 0, -4, 0], [-3, 0, 3, 0], [4, 0, 6, 0],
  [-1, -4, -1, -1.2], [1.5, -4, 1.5, -1.1], [2, 1.2, 2, 4],
];

// [w, h, d, x, z, y0]
// No face may sit on the same plane as another surface (a wall, the floor, the
// live room's heat volume, which is inset HEAT_INSET from the room): two faces
// at the same depth z-fight and flicker. Keep at least ~5 cm between them.
export const HEAT_INSET = 0.1;
export const FURNITURE = [
  [2.0, 0.45, 2.6, -4.6, -2.55, 0], [2.0, 0.25, 0.5, -4.6, -3.6, 0.45], // bed + pillow
  [0.6, 0.5, 0.6, -3.2, -3.55, 0], // nightstand
  [1.2, 0.75, 0.6, -2, -0.5, 0], // desk
  [3, 0.5, 0.9, -3.2, 3.3, 0], [3, 0.35, 0.25, -3.2, 3.7, 0.5], // sofa
  [1.4, 0.4, 0.8, -3.2, 1.8, 0], // coffee table
  [4.2, 0.9, 0.6, 3.8, -3.6, 0], [0.6, 0.9, 2.2, 5.6, -2.4, 0], // kitchen L
  [1.4, 0.75, 0.8, 4, 2, 0], [1.6, 0.08, 0.08, 4, 3.85, 1.2], // office desk + shelf
  [1.6, 0.5, 0.8, 0.2, -3.5, 0], // bath tub
];

export const SENSOR_POS = new THREE.Vector3(-1.2, 1.1, -0.6);

// Camera framing
export const HOME_DIR = new THREE.Vector3(15, 13, 17).normalize();
export function homeView(narrow) {
  return {
    position: HOME_DIR.clone().multiplyScalar(narrow ? 47 : 25),
    // phones: centre the house in the band left free by the HUD
    target: new THREE.Vector3(0, narrow ? 0.8 : 0.5, 0),
  };
}
export function roomView(room, narrow) {
  const target = room.center.clone().setY(0.5);
  return { position: target.clone().add(HOME_DIR.clone().multiplyScalar(narrow ? 24 : 15)), target };
}
