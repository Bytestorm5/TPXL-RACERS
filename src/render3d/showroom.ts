/**
 * Garage showroom: the procedural car mesh on a turntable with a simple orbit camera (drag to
 * orbit, wheel to zoom, slow auto-rotate when idle). Rebuilt whenever the build recompiles, so the
 * ride height, tyre width, wing and colour update live with the sliders.
 */
import * as THREE from 'three';
import type { VehicleSpec, VehicleState, WheelState } from '../sim/types';
import { CarMesh } from './carMesh';

const _tmpState = (spec: VehicleSpec): VehicleState => {
  const wheel = (): WheelState => ({
    omega: 0,
    load: 0,
    slipAngle: 0,
    slipRatio: 0,
    fx: 0,
    fy: 0,
    steer: 0,
    tire: { temp: 20, wear: 0 },
    brake: { temp: 20 },
    locked: false,
    spinning: false,
    utilisation: 0,
    compression: 0,
    onGround: true,
    surface: 'asphalt',
    x: 0,
    y: 0,
    brakeTorque: 0,
    driveTorque: 0,
  });
  return {
    x: 0,
    y: 0,
    z: spec.cgHeight,
    heading: 0,
    vx: 0,
    vy: 0,
    yawRate: 0,
    vz: 0,
    pitch: 0,
    roll: 0,
    pitchRate: 0,
    rollRate: 0,
    airborne: false,
    airTime: 0,
    wrecked: false,
    ax: 0,
    ay: 0,
    loadTransferLong: 0,
    loadTransferLatFront: 0,
    loadTransferLatRear: 0,
    wheels: [wheel(), wheel(), wheel(), wheel()],
    engineRpm: 0,
    throttleEffective: 0,
    gear: 0,
    shiftTimer: 0,
    input: { throttle: 0, brake: 0, steer: 0, handbrake: 0, shiftUp: false, shiftDown: false },
    speed: 0,
    offTrack: false,
    road: { z: 0, gradeAlong: 0, bankAcross: 0, surface: { kind: 'asphalt', grip: 1, rollingResistance: 0, roughness: 0, drag: 0, peakSlipScale: 1, slideRetention: 1 }, onTrack: true, s: 0, lateral: 0, halfWidth: 6, trackHeading: 0, curvature: 0 },
    odometer: 0,
    time: 0,
  };
};

export class Showroom {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private car: CarMesh | null = null;
  private yaw = 0.7;
  private pitch = 0.42;
  private dist = 7;
  private autoRotate = true;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private raf = 0;
  private lastT = 0;
  private idleSince = 0;
  private disposed = false;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.camera = new THREE.PerspectiveCamera(38, 16 / 9, 0.1, 100);
    this.scene.add(new THREE.HemisphereLight(0xdfe6f0, 0x2a2d33, 0.9));
    const key = new THREE.DirectionalLight(0xfff1d6, 2.4);
    key.position.set(4, 7, 3);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = key.shadow.camera.bottom = -5;
    key.shadow.camera.right = key.shadow.camera.top = 5;
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 30;
    key.shadow.bias = -0.0005;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x9fc7ff, 0.8);
    rim.position.set(-5, 3, -4);
    this.scene.add(rim);
    // turntable floor
    const floor = new THREE.Mesh(new THREE.CircleGeometry(4.2, 48), new THREE.MeshStandardMaterial({ color: 0x1e222a, roughness: 0.9, metalness: 0.1 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);
    const ring = new THREE.Mesh(new THREE.RingGeometry(4.2, 4.35, 64), new THREE.MeshBasicMaterial({ color: 0xff7a1a, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.005;
    this.scene.add(ring);

    canvas.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.lastT = performance.now();
    this.idleSince = this.lastT;
    this.raf = requestAnimationFrame(this.frame);
  }

  setSpec(spec: VehicleSpec): void {
    if (this.car) this.car.dispose();
    this.car = new CarMesh(spec, { player: false });
    this.car.update(_tmpState(spec), 0, 0, 0);
    this.scene.add(this.car.group);
    this.dist = Math.max(5.5, spec.length * 1.9);
  }

  private readonly onDown = (e: PointerEvent): void => {
    this.dragging = true;
    this.autoRotate = false;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.canvas.setPointerCapture?.(e.pointerId);
  };
  private readonly onMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    this.yaw -= (e.clientX - this.lastX) * 0.01;
    this.pitch = Math.max(0.05, Math.min(1.2, this.pitch + (e.clientY - this.lastY) * 0.008));
    this.lastX = e.clientX;
    this.lastY = e.clientY;
  };
  private readonly onUp = (): void => {
    this.dragging = false;
    this.idleSince = performance.now();
  };
  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.dist = Math.max(3, Math.min(14, this.dist * (e.deltaY > 0 ? 1.1 : 0.9)));
  };

  private readonly frame = (now: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, (now - this.lastT) / 1000);
    this.lastT = now;
    if (!this.dragging && !this.autoRotate && now - this.idleSince > 4000) this.autoRotate = true;
    if (this.autoRotate) this.yaw += dt * 0.35;
    const w = this.canvas.clientWidth || 400;
    const h = this.canvas.clientHeight || 220;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.renderer.setPixelRatio(dpr);
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    const cy = 0.6;
    this.camera.position.set(Math.sin(this.yaw) * Math.cos(this.pitch) * this.dist, cy + Math.sin(this.pitch) * this.dist, Math.cos(this.yaw) * Math.cos(this.pitch) * this.dist);
    this.camera.lookAt(0, cy, 0);
    this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.canvas.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    if (this.car) this.car.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | undefined;
      if (mat && !Array.isArray(mat)) mat.dispose();
    });
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
