// Visual FX adapted for racing: particles (smoke, sparks), camera shake.

import * as THREE from "https://esm.sh/three@0.160.0";

const particles = [];
const PARTICLE_GEO = new THREE.SphereGeometry(0.18, 5, 4);

function makeParticleMesh(color, emissive) {
  const mat = new THREE.MeshStandardMaterial({
    color,
    emissive: emissive ?? 0x000000,
    emissiveIntensity: emissive ? 1.2 : 0,
    transparent: true,
    opacity: 1,
    depthWrite: false,
  });
  return new THREE.Mesh(PARTICLE_GEO, mat);
}

export function spawnSmoke(scene, pos, opts = {}) {
  const {
    count = 4,
    color = 0xcccccc,
    speed = 1.2,
    life = 0.9,
    size = 1.0,
  } = opts;
  for (let i = 0; i < count; i++) {
    const m = makeParticleMesh(color);
    m.position.copy(pos);
    m.position.x += (Math.random() - 0.5) * 0.3;
    m.position.z += (Math.random() - 0.5) * 0.3;
    m.scale.setScalar(size * (0.8 + Math.random() * 0.6));
    scene.add(m);
    particles.push({
      mesh: m,
      v: new THREE.Vector3(
        (Math.random() - 0.5) * speed * 1.5,
        speed * (0.5 + Math.random() * 0.6),
        (Math.random() - 0.5) * speed * 1.5
      ),
      life: life * (0.7 + Math.random() * 0.6),
      maxLife: life,
      grow: true,
      gravity: -0.4,
    });
  }
}

export function spawnSparks(scene, pos, opts = {}) {
  const {
    count = 14,
    color = 0xffd070,
    emissive = 0xffa040,
    speed = 8,
    life = 0.4,
  } = opts;
  for (let i = 0; i < count; i++) {
    const m = makeParticleMesh(color, emissive);
    m.position.copy(pos);
    m.scale.setScalar(0.5 + Math.random() * 0.4);
    scene.add(m);
    const dir = new THREE.Vector3(
      (Math.random() - 0.5) * 2,
      Math.random() * 1.5,
      (Math.random() - 0.5) * 2
    ).normalize();
    particles.push({
      mesh: m,
      v: dir.multiplyScalar(speed * (0.7 + Math.random() * 0.5)),
      life: life * (0.7 + Math.random() * 0.6),
      maxLife: life,
      grow: false,
      gravity: 18,
    });
  }
}

export function spawnDust(scene, pos, opts = {}) {
  spawnSmoke(scene, pos, { color: 0xb59a7a, count: 2, speed: 1.0, life: 0.7, size: 0.8, ...opts });
}

export function spawnBoostTrail(scene, pos, opts = {}) {
  const m = makeParticleMesh(0xff8030, 0xff8030);
  m.position.copy(pos);
  m.scale.setScalar(1.2);
  scene.add(m);
  particles.push({ mesh: m, v: new THREE.Vector3(), life: 0.35, maxLife: 0.35, grow: false, gravity: 0 });
}

export function updateParticles(scene, dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    if (p.life <= 0) {
      scene.remove(p.mesh);
      p.mesh.material.dispose();
      particles.splice(i, 1);
      continue;
    }
    p.v.y -= (p.gravity || 0) * dt;
    p.mesh.position.addScaledVector(p.v, dt);
    const t = p.life / p.maxLife;
    p.mesh.material.opacity = t;
    if (p.grow) p.mesh.scale.multiplyScalar(1 + dt * 1.2);
  }
}

// Camera shake
let shakeAmount = 0;
let shakeDecay = 0;
const shakeOffset = new THREE.Vector3();

export function cameraShake(amount = 0.4, duration = 0.3) {
  shakeAmount = Math.max(shakeAmount, amount);
  shakeDecay = amount / duration;
}

export function applyCameraShake(camera, dt) {
  camera.position.sub(shakeOffset);
  if (shakeAmount > 0) {
    shakeOffset.set(
      (Math.random() - 0.5) * shakeAmount,
      (Math.random() - 0.5) * shakeAmount * 0.5,
      (Math.random() - 0.5) * shakeAmount
    );
    camera.position.add(shakeOffset);
    shakeAmount = Math.max(0, shakeAmount - shakeDecay * dt);
  } else {
    shakeOffset.set(0, 0, 0);
  }
}
