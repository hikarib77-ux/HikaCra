"use strict";
(function(){

// ===================================================================
// Renderer / Scene
// ===================================================================
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias:true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
const skyDay = new THREE.Color(0x8fc7ef);
const skyNight = new THREE.Color(0x0b0e2a);
scene.background = skyDay.clone();
scene.fog = new THREE.Fog(skyDay.getHex(), 60, 170);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth/window.innerHeight, 0.05, 500);
camera.rotation.order = 'YXZ';

const ambient = new THREE.AmbientLight(0xffffff, 0.55);
scene.add(ambient);
const sun = new THREE.DirectionalLight(0xffffff, 0.9);
scene.add(sun);
const sunTarget = new THREE.Object3D();
scene.add(sunTarget);
sun.target = sunTarget;

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth/window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ===================================================================
// Noise
// ===================================================================
function mulberry32(seed){
  let a = seed >>> 0;
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeNoise2D(seed){
  const p = new Uint8Array(256);
  for(let i=0;i<256;i++) p[i]=i;
  const rng = mulberry32(seed);
  for(let i=255;i>0;i--){ const j = Math.floor(rng()*(i+1)); const tmp=p[i]; p[i]=p[j]; p[j]=tmp; }
  const perm = new Uint8Array(512);
  for(let i=0;i<512;i++) perm[i]=p[i&255];
  function fade(t){ return t*t*t*(t*(t*6-15)+10); }
  function lerp(a,b,t){ return a+t*(b-a); }
  function grad(hash,x,y){
    const h = hash & 3;
    const u = h<2 ? x : y;
    const v = h<2 ? y : x;
    return ((h&1)?-u:u) + ((h&2)?-2*v:2*v);
  }
  return function(x,y){
    const X = Math.floor(x)&255, Y = Math.floor(y)&255;
    x -= Math.floor(x); y -= Math.floor(y);
    const u = fade(x), v = fade(y);
    const aa = perm[perm[X]+Y], ab = perm[perm[X]+Y+1];
    const ba = perm[perm[X+1]+Y], bb = perm[perm[X+1]+Y+1];
    return lerp(
      lerp(grad(aa,x,y), grad(ba,x-1,y), u),
      lerp(grad(ab,x,y-1), grad(bb,x-1,y-1), u),
      v
    );
  };
}
function fbm(noiseFn, x, y, octaves, lacunarity, gain){
  let amp=1, freq=1, sum=0, norm=0;
  for(let i=0;i<octaves;i++){
    sum += noiseFn(x*freq, y*freq) * amp;
    norm += amp; amp *= gain; freq *= lacunarity;
  }
  return sum / norm;
}
function makeValueNoise3D(seed){
  const size = 48;
  const rng = mulberry32(seed);
  const lattice = new Float32Array(size*size*size);
  for(let i=0;i<lattice.length;i++) lattice[i] = rng()*2-1;
  function li(x,y,z){
    return (((x%size)+size)%size)*size*size + (((y%size)+size)%size)*size + (((z%size)+size)%size);
  }
  function fade(t){ return t*t*t*(t*(t*6-15)+10); }
  function lerp(a,b,t){ return a+(b-a)*t; }
  return function(x,y,z){
    const x0=Math.floor(x), y0=Math.floor(y), z0=Math.floor(z);
    const xf=x-x0, yf=y-y0, zf=z-z0;
    const u=fade(xf), v=fade(yf), w=fade(zf);
    const c000=lattice[li(x0,y0,z0)],     c100=lattice[li(x0+1,y0,z0)];
    const c010=lattice[li(x0,y0+1,z0)],   c110=lattice[li(x0+1,y0+1,z0)];
    const c001=lattice[li(x0,y0,z0+1)],   c101=lattice[li(x0+1,y0,z0+1)];
    const c011=lattice[li(x0,y0+1,z0+1)], c111=lattice[li(x0+1,y0+1,z0+1)];
    const x00=lerp(c000,c100,u), x10=lerp(c010,c110,u);
    const x01=lerp(c001,c101,u), x11=lerp(c011,c111,u);
    const y0v=lerp(x00,x10,v), y1v=lerp(x01,x11,v);
    return lerp(y0v,y1v,w);
  };
}
let heightNoise, moistNoise, tempNoise, caveNoise;

// ===================================================================
// Block registry + texture atlas
// ===================================================================
const AIR=0, GRASS=1, DIRT=2, STONE=3, SAND=4, SANDSTONE=5, WOOD=6, LEAVES=7, WATER=8, SNOW=9, PLANKS=10, TORCH=11;
const BLOCK_LABEL = {1:'草',2:'土',3:'石',4:'砂',5:'砂岩',6:'丸太',7:'葉',8:'水',9:'雪',10:'板材',11:'松明'};

function blocksMovement(id){ return id!==AIR && id!==WATER && id!==TORCH; }
function isTargetable(id){ return id!==AIR && id!==WATER; }

const CELL = 16, ATLAS_COLS = 8, ATLAS_ROWS = 2;
const atlasCanvas = document.createElement('canvas');
atlasCanvas.width = ATLAS_COLS*CELL;
atlasCanvas.height = ATLAS_ROWS*CELL;
const actx = atlasCanvas.getContext('2d');

function speckle(ctx, s, base, n){
  ctx.fillStyle = base; ctx.fillRect(0,0,s,s);
  for(let i=0;i<n;i++){
    const shade = Math.random() < 0.5 ? 0 : 255;
    ctx.fillStyle = `rgba(${shade},${shade},${shade},${0.05+Math.random()*0.09})`;
    ctx.fillRect(Math.floor(Math.random()*s), Math.floor(Math.random()*s), 1, 1);
  }
}
function drawCell(index, drawFn){
  const col = index % ATLAS_COLS, row = Math.floor(index / ATLAS_COLS);
  actx.save();
  actx.translate(col*CELL, row*CELL);
  drawFn(actx, CELL);
  actx.restore();
}
drawCell(0, (ctx,s)=> speckle(ctx,s,'#5fa63c',45)); // grass top
drawCell(1, (ctx,s)=>{ // grass side (green MUST be drawn near y=0 of canvas = top of block)
  speckle(ctx,s,'#8b5a2b',30);
  ctx.fillStyle = '#5fa63c';
  for(let x=0;x<s;x++){ const h=5+Math.floor(Math.random()*3); ctx.fillRect(x,0,1,h); }
});
drawCell(2, (ctx,s)=> speckle(ctx,s,'#8b5a2b',45)); // dirt
drawCell(3, (ctx,s)=>{ // stone
  speckle(ctx,s,'#8a8a8a',40);
  ctx.fillStyle='rgba(0,0,0,0.15)';
  for(let i=0;i<6;i++) ctx.fillRect(Math.random()*s, Math.random()*s, 2+Math.random()*3, 1+Math.random()*2);
});
drawCell(4, (ctx,s)=> speckle(ctx,s,'#dccd7a',30)); // sand
drawCell(5, (ctx,s)=>{ // sandstone
  speckle(ctx,s,'#d9c78a',30);
  ctx.fillStyle='rgba(120,95,50,0.35)';
  for(let y=2;y<s;y+=5) ctx.fillRect(0,y,s,1);
});
drawCell(6, (ctx,s)=>{ // wood side (vertical grain, orientation-neutral)
  ctx.fillStyle='#6b4423'; ctx.fillRect(0,0,s,s);
  ctx.fillStyle='rgba(0,0,0,0.2)';
  for(let x=1;x<s;x+=3) ctx.fillRect(x,0,1,s);
});
drawCell(7, (ctx,s)=>{ // wood top/bottom (rings, orientation-neutral)
  ctx.fillStyle='#c9a06a'; ctx.fillRect(0,0,s,s);
  ctx.strokeStyle='rgba(90,55,25,0.6)';
  for(let r=1;r<s/2;r+=2){ ctx.beginPath(); ctx.arc(s/2,s/2,r,0,Math.PI*2); ctx.stroke(); }
});
drawCell(8, (ctx,s)=> speckle(ctx,s,'#2e7d32',65)); // leaves
drawCell(9, (ctx,s)=> speckle(ctx,s,'#3a7bd5',20)); // water
drawCell(10,(ctx,s)=> speckle(ctx,s,'#f2f8ff',20)); // snow
drawCell(11,(ctx,s)=>{ // planks (horizontal boards, orientation-neutral enough)
  speckle(ctx,s,'#c9a06a',25);
  ctx.fillStyle='rgba(90,60,30,0.4)';
  for(let y=3;y<s;y+=5) ctx.fillRect(0,y,s,1);
});

const atlasTexture = new THREE.CanvasTexture(atlasCanvas);
atlasTexture.magFilter = THREE.NearestFilter;
atlasTexture.minFilter = THREE.NearestFilter;
atlasTexture.generateMipmaps = false;
atlasTexture.needsUpdate = true;

function cellUV(index){
  const col = index % ATLAS_COLS, row = Math.floor(index / ATLAS_COLS);
  const cw = 1/ATLAS_COLS, ch = 1/ATLAS_ROWS, pad = 0.004;
  return { u0: col*cw+pad, u1: (col+1)*cw-pad, v0: 1-(row+1)*ch+pad, v1: 1-row*ch-pad };
}

const BLOCK_DEF = {
  [GRASS]:     { top:0,  side:1,  bottom:2  },
  [DIRT]:      { top:2,  side:2,  bottom:2  },
  [STONE]:     { top:3,  side:3,  bottom:3  },
  [SAND]:      { top:4,  side:4,  bottom:4  },
  [SANDSTONE]: { top:5,  side:5,  bottom:5  },
  [WOOD]:      { top:7,  side:6,  bottom:7  },
  [LEAVES]:    { top:8,  side:8,  bottom:8  },
  [WATER]:     { top:9,  side:9,  bottom:9  },
  [SNOW]:      { top:10, side:10, bottom:10 },
  [PLANKS]:    { top:11, side:11, bottom:11 },
};

// Face table: verified CCW winding (outward normal) for each cube face,
// with per-corner UV units derived from actual world-space axes so
// texture orientation matches the block's real up/down/left/right.
const FACES = [
  { name:'px', dir:[1,0,0],  corners:[[1,0,0],[1,1,0],[1,1,1],[1,0,1]], uv:[[0,0],[0,1],[1,1],[1,0]], shade:0.78 },
  { name:'nx', dir:[-1,0,0], corners:[[0,0,0],[0,0,1],[0,1,1],[0,1,0]], uv:[[0,0],[1,0],[1,1],[0,1]], shade:0.72 },
  { name:'py', dir:[0,1,0],  corners:[[0,1,0],[0,1,1],[1,1,1],[1,1,0]], uv:[[0,0],[0,1],[1,1],[1,0]], shade:1.0  },
  { name:'ny', dir:[0,-1,0], corners:[[0,0,0],[1,0,0],[1,0,1],[0,0,1]], uv:[[0,0],[1,0],[1,1],[0,1]], shade:0.55 },
  { name:'pz', dir:[0,0,1],  corners:[[1,0,1],[1,1,1],[0,1,1],[0,0,1]], uv:[[1,0],[1,1],[0,1],[0,0]], shade:0.9  },
  { name:'nz', dir:[0,0,-1], corners:[[0,0,0],[0,1,0],[1,1,0],[1,0,0]], uv:[[0,0],[0,1],[1,1],[1,0]], shade:0.66 },
];

function shouldRenderFace(curId, neighId){
  if(neighId === AIR || neighId === TORCH) return true;
  const curWater = curId === WATER, neighWater = neighId === WATER;
  if(neighWater && !curWater) return true;
  return false;
}

// ===================================================================
// World / chunk storage
// ===================================================================
const CHUNK_SIZE = 16, CHUNK_HEIGHT = 40, RADIUS = 4;
const SEA_LEVEL = 13;
const chunks = new Map();
let worldSeed = 1;
let edits = [];

function chunkKey(cx,cz){ return cx+'_'+cz; }
function blockIndex(lx,ly,lz){ return ly*CHUNK_SIZE*CHUNK_SIZE + lz*CHUNK_SIZE + lx; }
function getChunk(cx,cz){ return chunks.get(chunkKey(cx,cz)); }

function getBlock(x,y,z){
  if(y < 0) return STONE;
  if(y >= CHUNK_HEIGHT) return AIR;
  const cx = Math.floor(x/CHUNK_SIZE), cz = Math.floor(z/CHUNK_SIZE);
  const chunk = getChunk(cx,cz);
  if(!chunk) return AIR;
  const lx = ((x%CHUNK_SIZE)+CHUNK_SIZE)%CHUNK_SIZE;
  const lz = ((z%CHUNK_SIZE)+CHUNK_SIZE)%CHUNK_SIZE;
  return chunk.blocks[blockIndex(lx, y, lz)];
}
function setBlockRaw(x,y,z,id){
  if(y < 0 || y >= CHUNK_HEIGHT) return null;
  const cx = Math.floor(x/CHUNK_SIZE), cz = Math.floor(z/CHUNK_SIZE);
  const chunk = getChunk(cx,cz);
  if(!chunk) return null;
  const lx = ((x%CHUNK_SIZE)+CHUNK_SIZE)%CHUNK_SIZE;
  const lz = ((z%CHUNK_SIZE)+CHUNK_SIZE)%CHUNK_SIZE;
  chunk.blocks[blockIndex(lx,y,lz)] = id;
  return chunk;
}
function setBlockPlayer(x,y,z,id){
  const chunk = setBlockRaw(x,y,z,id);
  if(!chunk) return;
  edits.push({x,y,z,id});
  rebuildChunkMesh(chunk);
  const lx = ((x%CHUNK_SIZE)+CHUNK_SIZE)%CHUNK_SIZE;
  const lz = ((z%CHUNK_SIZE)+CHUNK_SIZE)%CHUNK_SIZE;
  if(lx===0) rebuildNeighborIfExists(chunk.cx-1, chunk.cz);
  if(lx===CHUNK_SIZE-1) rebuildNeighborIfExists(chunk.cx+1, chunk.cz);
  if(lz===0) rebuildNeighborIfExists(chunk.cx, chunk.cz-1);
  if(lz===CHUNK_SIZE-1) rebuildNeighborIfExists(chunk.cx, chunk.cz+1);
}
function rebuildNeighborIfExists(cx,cz){ const c = getChunk(cx,cz); if(c) rebuildChunkMesh(c); }

// ---------------- Terrain generation ----------------
function heightAt(x,z){
  const h = fbm(heightNoise, x*0.01, z*0.01, 4, 2.0, 0.5);
  return Math.floor(((h+1)/2)*26) + 6;
}
function moistureAt(x,z){ return fbm(moistNoise, x*0.015, z*0.015, 3, 2.0, 0.5); }
function temperatureAt(x,z){ return fbm(tempNoise, x*0.008, z*0.008, 3, 2.0, 0.5); }
function biomeAt(x,z,elev){
  if(elev > 26) return 'mountain';
  if(elev <= SEA_LEVEL+1) return 'beach';
  const t = temperatureAt(x,z), m = moistureAt(x,z);
  if(t > 0.25 && m < -0.1) return 'desert';
  if(m > 0.2) return 'forest';
  return 'plains';
}
function placeTree(blocks, lx, elev, lz, trunkH){
  for(let dx=-2; dx<=2; dx++){
    for(let dz=-2; dz<=2; dz++){
      for(let dy=0; dy<=2; dy++){
        if(Math.abs(dx)+Math.abs(dz)+dy > 3) continue;
        if(Math.random() > 0.85) continue;
        const fx=lx+dx, fz=lz+dz, fy=elev+trunkH-1+dy;
        if(fx<0||fx>=CHUNK_SIZE||fz<0||fz>=CHUNK_SIZE||fy>=CHUNK_HEIGHT) continue;
        const i = blockIndex(fx,fy,fz);
        if(blocks[i] === AIR) blocks[i] = LEAVES;
      }
    }
  }
  for(let ty=1; ty<=trunkH; ty++){
    const fy = elev+ty;
    if(fy>=CHUNK_HEIGHT) break;
    blocks[blockIndex(lx,fy,lz)] = WOOD;
  }
}
function generateChunkBlocks(cx,cz){
  const blocks = new Uint8Array(CHUNK_SIZE*CHUNK_SIZE*CHUNK_HEIGHT);
  for(let lx=0; lx<CHUNK_SIZE; lx++){
    for(let lz=0; lz<CHUNK_SIZE; lz++){
      const wx = cx*CHUNK_SIZE+lx, wz = cz*CHUNK_SIZE+lz;
      const elev = heightAt(wx,wz);
      const bio = biomeAt(wx,wz,elev);
      for(let y=0; y<CHUNK_HEIGHT; y++){
        let id = AIR;
        if(y === 0) id = STONE;
        else if(y < elev-3) id = STONE;
        else if(y < elev) id = (bio==='desert') ? SANDSTONE : DIRT;
        else if(y === elev){
          if(bio==='desert' || bio==='beach') id = SAND;
          else if(bio==='mountain') id = (elev>29 ? SNOW : STONE);
          else id = GRASS;
        } else if(y <= SEA_LEVEL){
          id = WATER;
        }
        if(id === STONE && y > 2 && y < elev-4){
          const cn = caveNoise(wx*0.09, y*0.12, wz*0.09);
          if(cn > 0.62) id = AIR;
        }
        if(id !== AIR) blocks[blockIndex(lx,y,lz)] = id;
      }
      if(elev > SEA_LEVEL+1 && elev < 29 && lx>=2 && lx<=13 && lz>=2 && lz<=13){
        const r = Math.random();
        if(bio==='forest' && r < 0.05) placeTree(blocks, lx, elev, lz, 4+Math.floor(Math.random()*2));
        else if(bio==='plains' && r < 0.012) placeTree(blocks, lx, elev, lz, 3+Math.floor(Math.random()*2));
      }
    }
  }
  return blocks;
}

// ---------------- Meshing ----------------
const opaqueMaterial = new THREE.MeshLambertMaterial({ map: atlasTexture, vertexColors: true });
const waterMaterial = new THREE.MeshLambertMaterial({ map: atlasTexture, vertexColors: true, transparent:true, opacity:0.78, depthWrite:false, side: THREE.DoubleSide });

function buildGeometry(positions, normals, uvs, colors, indices){
  if(indices.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  return geo;
}

// -------- Torch objects (rendered separately, not part of cube mesh) --------
const torchObjects = new Map();
function makeTorchMesh(){
  const group = new THREE.Group();
  const stick = new THREE.Mesh(new THREE.BoxGeometry(0.1,0.5,0.1), new THREE.MeshLambertMaterial({ color:0x6b4423 }));
  stick.position.y = 0.15;
  group.add(stick);
  const tip = new THREE.Mesh(new THREE.BoxGeometry(0.16,0.16,0.16), new THREE.MeshBasicMaterial({ color:0xffcc55 }));
  tip.position.y = 0.42;
  group.add(tip);
  return group;
}
function syncTorchesForChunk(chunk){
  const baseX = chunk.cx*CHUNK_SIZE, baseZ = chunk.cz*CHUNK_SIZE;
  for(const [k,obj] of Array.from(torchObjects.entries())){
    const [tx,,tz] = k.split(',').map(Number);
    if(tx>=baseX && tx<baseX+CHUNK_SIZE && tz>=baseZ && tz<baseZ+CHUNK_SIZE){
      scene.remove(obj.mesh); scene.remove(obj.light);
      torchObjects.delete(k);
    }
  }
  for(let lx=0; lx<CHUNK_SIZE; lx++){
    for(let lz=0; lz<CHUNK_SIZE; lz++){
      for(let ly=0; ly<CHUNK_HEIGHT; ly++){
        if(chunk.blocks[blockIndex(lx,ly,lz)] === TORCH){
          const wx=baseX+lx, wy=ly, wz=baseZ+lz;
          const mesh = makeTorchMesh();
          mesh.position.set(wx+0.5, wy, wz+0.5);
          scene.add(mesh);
          const light = new THREE.PointLight(0xffaa55, 1.1, 8, 2);
          light.position.set(wx+0.5, wy+0.5, wz+0.5);
          scene.add(light);
          torchObjects.set(wx+','+wy+','+wz, { mesh, light });
        }
      }
    }
  }
}

function rebuildChunkMesh(chunk){
  if(chunk.meshOpaque){ scene.remove(chunk.meshOpaque); chunk.meshOpaque.geometry.dispose(); chunk.meshOpaque=null; }
  if(chunk.meshWater){ scene.remove(chunk.meshWater); chunk.meshWater.geometry.dispose(); chunk.meshWater=null; }

  const positions=[], normals=[], uvs=[], colors=[], indices=[];
  const wpositions=[], wnormals=[], wuvs=[], wcolors=[], windices=[];
  let vI=0, wI=0;

  const baseX = chunk.cx*CHUNK_SIZE, baseZ = chunk.cz*CHUNK_SIZE;
  const blocks = chunk.blocks;

  for(let lx=0; lx<CHUNK_SIZE; lx++){
    for(let lz=0; lz<CHUNK_SIZE; lz++){
      for(let ly=0; ly<CHUNK_HEIGHT; ly++){
        const id = blocks[blockIndex(lx,ly,lz)];
        if(id === AIR || id === TORCH) continue;
        const wx = baseX+lx, wy = ly, wz = baseZ+lz;
        const isWater = id === WATER;
        const def = BLOCK_DEF[id];
        for(let f=0; f<6; f++){
          const face = FACES[f];
          const nId = getBlock(wx+face.dir[0], wy+face.dir[1], wz+face.dir[2]);
          if(!shouldRenderFace(id, nId)) continue;
          const role = face.name==='py' ? 'top' : (face.name==='ny' ? 'bottom' : 'side');
          const { u0,v0,u1,v1 } = cellUV(def[role]);
          const P = isWater ? wpositions : positions;
          const N = isWater ? wnormals : normals;
          const U = isWater ? wuvs : uvs;
          const C = isWater ? wcolors : colors;
          const I = isWater ? windices : indices;
          const base = isWater ? wI : vI;
          for(let c=0;c<4;c++){
            const corner = face.corners[c];
            const uv = face.uv[c];
            P.push(wx+corner[0], wy+corner[1], wz+corner[2]);
            N.push(face.dir[0], face.dir[1], face.dir[2]);
            U.push(uv[0] ? u1 : u0, uv[1] ? v1 : v0);
            C.push(face.shade, face.shade, face.shade);
          }
          I.push(base,base+1,base+2, base,base+2,base+3);
          if(isWater) wI+=4; else vI+=4;
        }
      }
    }
  }

  const geoOpaque = buildGeometry(positions, normals, uvs, colors, indices);
  if(geoOpaque){
    const mesh = new THREE.Mesh(geoOpaque, opaqueMaterial);
    scene.add(mesh);
    chunk.meshOpaque = mesh;
  }
  const geoWater = buildGeometry(wpositions, wnormals, wuvs, wcolors, windices);
  if(geoWater){
    const mesh = new THREE.Mesh(geoWater, waterMaterial);
    mesh.renderOrder = 1;
    scene.add(mesh);
    chunk.meshWater = mesh;
  }
  syncTorchesForChunk(chunk);
}

// ---------------- World lifecycle ----------------
function buildAllChunkBlockData(){
  for(const c of chunks.values()){
    if(c.meshOpaque){ scene.remove(c.meshOpaque); c.meshOpaque.geometry.dispose(); }
    if(c.meshWater){ scene.remove(c.meshWater); c.meshWater.geometry.dispose(); }
  }
  for(const obj of torchObjects.values()){ scene.remove(obj.mesh); scene.remove(obj.light); }
  torchObjects.clear();
  chunks.clear();
  for(let cx=-RADIUS; cx<RADIUS; cx++){
    for(let cz=-RADIUS; cz<RADIUS; cz++){
      chunks.set(chunkKey(cx,cz), { cx, cz, blocks: generateChunkBlocks(cx,cz), meshOpaque:null, meshWater:null });
    }
  }
}
function buildAllChunkMeshes(){ for(const chunk of chunks.values()) rebuildChunkMesh(chunk); }
function applyEdits(list){ for(const e of list) setBlockRaw(e.x,e.y,e.z,e.id); }

function newWorld(seed){
  worldSeed = seed >>> 0;
  heightNoise = makeNoise2D(worldSeed+1);
  moistNoise = makeNoise2D(worldSeed+2);
  tempNoise = makeNoise2D(worldSeed+3);
  caveNoise = makeValueNoise3D(worldSeed+4);
  buildAllChunkBlockData();
  edits = [];
  buildAllChunkMeshes();
  spawnMobs();
  respawnPlayer();
}

// ===================================================================
// Player
// ===================================================================
const player = { x:0.5, y:20, z:0.5, yaw:0, pitch:0, velY:0, grounded:false };
const GRAVITY=24, JUMP_SPEED=8.6, WALK_SPEED=4.6, SPRINT_MULT=1.6, FLY_SPEED=10, EYE_HEIGHT=1.6;
let flying = false;

function respawnPlayer(){
  const elev = heightAt(0,0);
  player.x=0.5; player.z=0.5; player.y=Math.max(elev,SEA_LEVEL)+2;
  player.yaw=0; player.pitch=0; player.velY=0; player.grounded=false; flying=false;
}
function canOccupy(x,y,z){
  for(let hgt=0.1; hgt<=1.5; hgt+=0.6){
    if(blocksMovement(getBlock(Math.floor(x),Math.floor(y+hgt),Math.floor(z)))) return false;
  }
  return true;
}

// ===================================================================
// Mobs
// ===================================================================
const mobs = [];
function makeMobMesh(kind){
  const group = new THREE.Group();
  const bodyColor = kind==='sheep' ? 0xf2f2f2 : 0xe58fae;
  const bodyMat = new THREE.MeshLambertMaterial({ color: bodyColor });
  const legMat = new THREE.MeshLambertMaterial({ color: kind==='sheep' ? 0xdedede : 0xcf6f90 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.9,0.6,0.6), bodyMat);
  body.position.y = 0.6;
  group.add(body);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.4,0.4,0.4), bodyMat);
  head.position.set(0.55,0.65,0);
  group.add(head);
  for(const [sx,sz] of [[0.3,0.2],[0.3,-0.2],[-0.3,0.2],[-0.3,-0.2]]){
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.18,0.4,0.18), legMat);
    leg.position.set(sx, 0.2, sz);
    group.add(leg);
  }
  return group;
}
function spawnMobs(){
  for(const m of mobs) scene.remove(m.mesh);
  mobs.length = 0;
  const count = 16;
  let tries = 0;
  while(mobs.length < count && tries < count*20){
    tries++;
    const x = Math.floor((Math.random()*2-1) * (RADIUS*CHUNK_SIZE-4));
    const z = Math.floor((Math.random()*2-1) * (RADIUS*CHUNK_SIZE-4));
    const elev = heightAt(x,z);
    if(elev <= SEA_LEVEL+1) continue;
    const bio = biomeAt(x,z,elev);
    if(bio !== 'plains' && bio !== 'forest') continue;
    const kind = Math.random() < 0.5 ? 'sheep' : 'pig';
    const mesh = makeMobMesh(kind);
    scene.add(mesh);
    mobs.push({ x:x+0.5, y:elev+1, z:z+0.5, yaw:Math.random()*Math.PI*2, velY:0, timer:1+Math.random()*3, mesh, kind });
  }
}
function updateMobs(dt){
  for(const m of mobs){
    m.timer -= dt;
    if(m.timer <= 0){ m.yaw = Math.random()*Math.PI*2; m.timer = 2+Math.random()*4; }
    const speed = 1.1;
    const dx = Math.sin(m.yaw)*speed*dt, dz = Math.cos(m.yaw)*speed*dt;
    const nx = m.x+dx, nz = m.z+dz;
    if(canOccupy(nx, m.y, m.z)) m.x = nx; else m.timer = 0;
    if(canOccupy(m.x, m.y, nz)) m.z = nz; else m.timer = 0;
    m.velY -= GRAVITY*dt;
    const ny = m.y + m.velY*dt;
    if(m.velY <= 0){
      if(blocksMovement(getBlock(Math.floor(m.x), Math.floor(ny), Math.floor(m.z)))){ m.y = Math.floor(ny)+1; m.velY=0; }
      else { m.y = ny; }
    } else { m.y = ny; }
    if(m.y < -20){ m.y = heightAt(0,0)+2; m.x=0.5; m.z=0.5; }
    m.mesh.position.set(m.x, m.y, m.z);
    m.mesh.rotation.y = -m.yaw;
  }
}

// ===================================================================
// Survival: inventory, crafting, mode
// ===================================================================
let gameMode = 'creative';
const CREATIVE_HOTBAR = [GRASS,DIRT,STONE,SAND,SANDSTONE,WOOD,LEAVES,WATER,SNOW];
const SURVIVAL_HOTBAR = [GRASS,DIRT,STONE,SAND,SANDSTONE,WOOD,PLANKS,LEAVES,TORCH];
let ACTIVE_HOTBAR = CREATIVE_HOTBAR;

const ITEM_NAME_BY_BLOCK_ID = { [GRASS]:'grass',[DIRT]:'dirt',[STONE]:'stone',[SAND]:'sand',[SANDSTONE]:'sandstone',[WOOD]:'wood',[LEAVES]:'leaves',[SNOW]:'snow',[PLANKS]:'planks',[TORCH]:'torch' };
const ITEM_LABEL = { grass:'草',dirt:'土',stone:'石',sand:'砂',sandstone:'砂岩',wood:'丸太',leaves:'葉',snow:'雪',planks:'板材',torch:'松明',stick:'棒',woodPickaxe:'木のツルハシ',stonePickaxe:'石のツルハシ' };

function freshInventory(){
  return { grass:0,dirt:0,stone:0,sand:0,sandstone:0,wood:0,leaves:0,snow:0,planks:0,torch:0,stick:0,woodPickaxe:0,stonePickaxe:0 };
}
let inventory = freshInventory();

const RECIPES = [
  { label:'丸太 → 板材', need:{wood:1}, give:{planks:4} },
  { label:'板材 → 棒', need:{planks:2}, give:{stick:4} },
  { label:'棒 + 板材 → 松明', need:{stick:1, planks:1}, give:{torch:4} },
  { label:'棒 + 板材 → 木のツルハシ', need:{stick:2, planks:3}, give:{woodPickaxe:1} },
  { label:'棒 + 石 → 石のツルハシ', need:{stick:2, stone:3}, give:{stonePickaxe:1} },
];

// ===================================================================
// Texture icons for hotbar
// ===================================================================
const hotbarIconCanvas = {};
Array.from(new Set([...CREATIVE_HOTBAR, ...SURVIVAL_HOTBAR])).forEach(id => {
  if(id === TORCH) return;
  const c = document.createElement('canvas'); c.width=c.height=CELL;
  const cctx = c.getContext('2d');
  const cellIdx = BLOCK_DEF[id].top;
  const col = cellIdx % ATLAS_COLS, row = Math.floor(cellIdx/ATLAS_COLS);
  cctx.drawImage(atlasCanvas, col*CELL, row*CELL, CELL, CELL, 0,0,CELL,CELL);
  hotbarIconCanvas[id] = c.toDataURL();
});
(function(){
  const c = document.createElement('canvas'); c.width=c.height=CELL;
  const cctx = c.getContext('2d');
  cctx.fillStyle = '#6b4423'; cctx.fillRect(6,4,4,11);
  cctx.fillStyle = '#ffcc55'; cctx.fillRect(5,1,6,5);
  hotbarIconCanvas[TORCH] = c.toDataURL();
})();

// ===================================================================
// Input state
// ===================================================================
const keysDown = new Set();
let locked = false;
let lastSpaceTime = -1000;
let selectedIndex = 0;
let craftPanelOpen = false;

const startOverlay = document.getElementById('startOverlay');
const loadingOverlay = document.getElementById('loadingOverlay');
const modeOverlay = document.getElementById('modeOverlay');
const toastEl = document.getElementById('toast');
const craftPanelEl = document.getElementById('craftPanel');

function requestLock(){ if(document.pointerLockElement !== canvas) canvas.requestPointerLock(); }
canvas.addEventListener('click', requestLock);
startOverlay.addEventListener('click', requestLock);

document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
  if(!craftPanelOpen) startOverlay.classList.toggle('hidden', locked);
  if(!locked) keysDown.clear();
});
document.addEventListener('pointerlockerror', () => {
  startOverlay.querySelector('p').textContent = 'マウスロックに失敗しました。もう一度クリックしてみてください。';
  if(!craftPanelOpen) startOverlay.classList.remove('hidden');
});
document.addEventListener('mousemove', (e) => {
  if(!locked) return;
  const SENS = 0.0022;
  player.yaw -= e.movementX*SENS;
  player.pitch -= e.movementY*SENS;
  const lim = Math.PI/2 - 0.05;
  if(player.pitch>lim) player.pitch=lim;
  if(player.pitch<-lim) player.pitch=-lim;
});

let toastTimer = null;
function showToast(msg){
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1500);
}

function toggleCraftPanel(){
  craftPanelOpen = !craftPanelOpen;
  craftPanelEl.classList.toggle('hidden', !craftPanelOpen);
  if(craftPanelOpen){
    document.exitPointerLock();
    refreshCraftPanel();
  } else {
    requestLock();
  }
}
function refreshCraftPanel(){
  craftPanelEl.innerHTML = '';
  const title = document.createElement('h2'); title.textContent = 'クラフト（Cキーで閉じる）';
  craftPanelEl.appendChild(title);

  const inv = document.createElement('div'); inv.className = 'invRow';
  Object.keys(inventory).forEach(k => {
    const chip = document.createElement('span'); chip.className = 'chip';
    chip.textContent = `${ITEM_LABEL[k]}: ${inventory[k]}`;
    inv.appendChild(chip);
  });
  craftPanelEl.appendChild(inv);

  RECIPES.forEach(r => {
    const row = document.createElement('div'); row.className = 'recipeRow';
    const needText = Object.entries(r.need).map(([k,v]) => `${ITEM_LABEL[k]}x${v}`).join(' + ');
    const giveText = Object.entries(r.give).map(([k,v]) => `${ITEM_LABEL[k]}x${v}`).join(' + ');
    const text = document.createElement('span'); text.textContent = `${needText} → ${giveText}`;
    row.appendChild(text);
    const btn = document.createElement('button'); btn.textContent = '作る';
    const canCraft = Object.entries(r.need).every(([k,v]) => (inventory[k]||0) >= v);
    btn.disabled = !canCraft;
    btn.addEventListener('click', () => {
      Object.entries(r.need).forEach(([k,v]) => inventory[k] -= v);
      Object.entries(r.give).forEach(([k,v]) => inventory[k] = (inventory[k]||0) + v);
      refreshCraftPanel();
      refreshHotbarCounts();
    });
    row.appendChild(btn);
    craftPanelEl.appendChild(row);
  });

  const closeBtn = document.createElement('button'); closeBtn.textContent = '閉じる';
  closeBtn.className = 'closeBtn';
  closeBtn.addEventListener('click', toggleCraftPanel);
  craftPanelEl.appendChild(closeBtn);
}

window.addEventListener('keydown', (e) => {
  if(e.code === 'KeyC' && gameMode === 'survival' && !e.repeat){
    toggleCraftPanel();
  }
});

window.addEventListener('keydown', (e) => {
  if(!locked) return;
  keysDown.add(e.code);
  if(e.code === 'Space' && !e.repeat){
    const now = performance.now();
    if(now - lastSpaceTime < 300){
      flying = !flying; player.velY = 0; lastSpaceTime = -1000;
    } else {
      lastSpaceTime = now;
      if(!flying && player.grounded){ player.velY = JUMP_SPEED; player.grounded=false; }
    }
  }
  if(e.code >= 'Digit1' && e.code <= 'Digit9'){
    const idx = parseInt(e.code.replace('Digit',''),10) - 1;
    if(idx < ACTIVE_HOTBAR.length){ selectedIndex = idx; updateHotbarSel(); }
  }
});
window.addEventListener('keyup', (e) => keysDown.delete(e.code));

const _dir = new THREE.Vector3();
function getTarget(){
  camera.getWorldDirection(_dir);
  const origin = camera.position;
  let prevBlock = null;
  for(let t=0; t<7; t+=0.06){
    const px=origin.x+_dir.x*t, py=origin.y+_dir.y*t, pz=origin.z+_dir.z*t;
    const bx=Math.floor(px), by=Math.floor(py), bz=Math.floor(pz);
    if(isTargetable(getBlock(bx,by,bz))) return { target:[bx,by,bz], place: prevBlock };
    prevBlock = [bx,by,bz];
  }
  return null;
}

canvas.addEventListener('mousedown', (e) => {
  if(!locked) return;
  if(e.button === 0){
    const t = getTarget();
    if(t){
      const [bx,by,bz] = t.target;
      const id = getBlock(bx,by,bz);
      if(gameMode === 'survival'){
        const needsPick = (id===STONE || id===SANDSTONE || id===SNOW);
        if(needsPick && inventory.woodPickaxe<=0 && inventory.stonePickaxe<=0){
          showToast('⛏ ツルハシが必要です');
          return;
        }
        const name = ITEM_NAME_BY_BLOCK_ID[id];
        if(name){ inventory[name] = (inventory[name]||0) + 1; refreshHotbarCounts(); }
      }
      setBlockPlayer(bx,by,bz, AIR);
    }
  } else if(e.button === 2){
    const t = getTarget();
    if(t && t.place){
      const [px,py,pz] = t.place;
      const feet=[Math.floor(player.x),Math.floor(player.y),Math.floor(player.z)];
      const head=[Math.floor(player.x),Math.floor(player.y+1.2),Math.floor(player.z)];
      const same=(a,b)=>a[0]===b[0]&&a[1]===b[1]&&a[2]===b[2];
      if(same([px,py,pz],feet) || same([px,py,pz],head)) return;
      const chosenId = ACTIVE_HOTBAR[selectedIndex];
      if(gameMode === 'survival'){
        const name = ITEM_NAME_BY_BLOCK_ID[chosenId];
        if(!name || (inventory[name]||0) <= 0){ showToast('アイテムがありません'); return; }
        inventory[name]--;
        refreshHotbarCounts();
      }
      setBlockPlayer(px,py,pz, chosenId);
    }
  }
});
canvas.addEventListener('contextmenu', (e)=>e.preventDefault());
canvas.addEventListener('wheel', (e) => {
  if(!locked) return;
  selectedIndex = (selectedIndex + (e.deltaY>0?1:-1) + ACTIVE_HOTBAR.length) % ACTIVE_HOTBAR.length;
  updateHotbarSel();
});

// ===================================================================
// UI: hotbar
// ===================================================================
const hotbarEl = document.getElementById('hotbar');
function buildHotbarDOM(){
  hotbarEl.innerHTML = '';
  ACTIVE_HOTBAR.forEach((id,i) => {
    const slot = document.createElement('div');
    slot.className = 'slot' + (i===selectedIndex ? ' sel' : '');
    slot.style.backgroundImage = `url(${hotbarIconCanvas[id]})`;
    const label = document.createElement('em'); label.textContent = BLOCK_LABEL[id];
    slot.appendChild(label);
    const num = document.createElement('span'); num.textContent = i+1;
    slot.appendChild(num);
    if(gameMode === 'survival'){
      const count = document.createElement('i'); count.className = 'count';
      count.textContent = inventory[ITEM_NAME_BY_BLOCK_ID[id]] || 0;
      slot.appendChild(count);
      slot.classList.toggle('empty', (inventory[ITEM_NAME_BY_BLOCK_ID[id]]||0) <= 0);
    }
    slot.addEventListener('click', () => { selectedIndex=i; updateHotbarSel(); });
    hotbarEl.appendChild(slot);
  });
}
function updateHotbarSel(){
  Array.from(hotbarEl.children).forEach((c,i) => c.classList.toggle('sel', i===selectedIndex));
}
function refreshHotbarCounts(){
  if(gameMode !== 'survival') return;
  Array.from(hotbarEl.children).forEach((slot,i) => {
    const id = ACTIVE_HOTBAR[i];
    const countEl = slot.querySelector('.count');
    const n = inventory[ITEM_NAME_BY_BLOCK_ID[id]] || 0;
    if(countEl) countEl.textContent = n;
    slot.classList.toggle('empty', n<=0);
  });
}
function resetInventory(){ inventory = freshInventory(); refreshHotbarCounts(); }
function updateHotbarForMode(){
  ACTIVE_HOTBAR = gameMode === 'survival' ? SURVIVAL_HOTBAR : CREATIVE_HOTBAR;
  selectedIndex = 0;
  buildHotbarDOM();
}

function startGame(mode){
  gameMode = mode;
  updateHotbarForMode();
  modeOverlay.classList.add('hidden');
  requestLock();
}
document.getElementById('creativeBtn').addEventListener('click', () => startGame('creative'));
document.getElementById('survivalBtn').addEventListener('click', () => startGame('survival'));

document.getElementById('newWorldBtn').addEventListener('click', () => {
  runWithLoadingScreen(() => {
    newWorld(Math.floor(Math.random()*1e9));
    if(gameMode === 'survival') resetInventory();
  });
});
document.getElementById('saveBtn').addEventListener('click', () => {
  const data = { seed: worldSeed, edits, dayTime, gameMode, inventory,
    player: { x:player.x, y:player.y, z:player.z, yaw:player.yaw, pitch:player.pitch } };
  const blob = new Blob([JSON.stringify(data)], { type:'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'voxel-world-save.json';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
});
const loadInput = document.getElementById('loadInput');
document.getElementById('loadBtn').addEventListener('click', () => loadInput.click());
loadInput.addEventListener('change', () => {
  const file = loadInput.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try{
      const data = JSON.parse(reader.result);
      runWithLoadingScreen(() => {
        worldSeed = data.seed >>> 0;
        heightNoise = makeNoise2D(worldSeed+1);
        moistNoise = makeNoise2D(worldSeed+2);
        tempNoise = makeNoise2D(worldSeed+3);
        caveNoise = makeValueNoise3D(worldSeed+4);
        buildAllChunkBlockData();
        edits = data.edits || [];
        applyEdits(edits);
        buildAllChunkMeshes();
        spawnMobs();
        gameMode = data.gameMode || 'creative';
        inventory = data.inventory || freshInventory();
        updateHotbarForMode();
        if(data.player){
          player.x=data.player.x; player.y=data.player.y; player.z=data.player.z;
          player.yaw=data.player.yaw; player.pitch=data.player.pitch;
        }
        if(typeof data.dayTime === 'number') dayTime = data.dayTime;
      });
    }catch(err){
      alert('セーブファイルの読み込みに失敗しました。');
    }
  };
  reader.readAsText(file);
  loadInput.value = '';
});

function runWithLoadingScreen(fn){
  loadingOverlay.classList.remove('hidden');
  requestAnimationFrame(() => setTimeout(() => {
    fn();
    loadingOverlay.classList.add('hidden');
  }, 20));
}

// ===================================================================
// Day / night cycle
// ===================================================================
const DAY_LENGTH = 300;
let dayTime = 0.28;
const dayIndicatorEl = document.getElementById('dayIndicator');
const tmpColor = new THREE.Color();
function updateDayNight(dt){
  dayTime = (dayTime + dt/DAY_LENGTH) % 1;
  const angle = dayTime * Math.PI * 2;
  const height = Math.sin(angle);
  sun.position.set(camera.position.x + Math.cos(angle)*80, height*80+10, camera.position.z + 20);
  sunTarget.position.set(camera.position.x, camera.position.y, camera.position.z);
  const bright = Math.max(0.08, height*0.5+0.5);
  sun.intensity = 0.25 + bright*0.8;
  ambient.intensity = 0.25 + bright*0.4;
  tmpColor.copy(skyNight).lerp(skyDay, bright);
  scene.background = tmpColor;
  scene.fog.color = tmpColor;
  dayIndicatorEl.textContent = height>0.05 ? '☀️' : (height>-0.35 ? '🌇' : '🌙');
}

// ===================================================================
// Main loop
// ===================================================================
const edgeGeom = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.02,1.02,1.02));
const highlight = new THREE.LineSegments(edgeGeom, new THREE.LineBasicMaterial({ color:0xffffff }));
highlight.visible = false;
scene.add(highlight);

const clock = new THREE.Clock();
const fwd = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3(0,1,0);

function tick(){
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.05);
  updateDayNight(dt);
  updateMobs(dt);

  if(locked){
    fwd.set(0,0,-1).applyAxisAngle(up, player.yaw);
    right.set(1,0,0).applyAxisAngle(up, player.yaw);
    let mvY = (keysDown.has('KeyW')?1:0) - (keysDown.has('KeyS')?1:0);
    let mvX = (keysDown.has('KeyD')?1:0) - (keysDown.has('KeyA')?1:0);
    const len = Math.hypot(mvX,mvY);
    if(len>1){ mvX/=len; mvY/=len; }
    const sprinting = keysDown.has('ShiftLeft') || keysDown.has('ShiftRight');
    const speed = (flying?FLY_SPEED:WALK_SPEED) * (sprinting && !flying ? SPRINT_MULT : 1);
    const dx = (fwd.x*mvY+right.x*mvX)*speed*dt;
    const dz = (fwd.z*mvY+right.z*mvX)*speed*dt;
    if(dx!==0){ const nx=player.x+dx; if(canOccupy(nx,player.y,player.z)) player.x=nx; }
    if(dz!==0){ const nz=player.z+dz; if(canOccupy(player.x,player.y,nz)) player.z=nz; }

    const inWater = getBlock(Math.floor(player.x), Math.floor(player.y+0.7), Math.floor(player.z)) === WATER;

    if(flying){
      player.velY = 0;
      let vy=0;
      if(keysDown.has('Space')) vy+=1;
      if(sprinting) vy-=1;
      const ny = player.y + vy*FLY_SPEED*dt;
      if(vy===0 || canOccupy(player.x,ny,player.z) || canOccupy(player.x,ny+EYE_HEIGHT,player.z)) player.y=ny;
      player.grounded=false;
    } else {
      const gravMult = inWater ? 0.25 : 1;
      player.velY -= GRAVITY*gravMult*dt;
      if(inWater){
        if(player.velY < -2.5) player.velY=-2.5;
        if(keysDown.has('Space')) player.velY=2.5;
      }
      let ny = player.y + player.velY*dt;
      if(player.velY<=0){
        if(blocksMovement(getBlock(Math.floor(player.x),Math.floor(ny),Math.floor(player.z)))){
          player.y = Math.floor(ny)+1; player.velY=0; player.grounded=true;
        } else { player.y=ny; player.grounded=false; }
      } else {
        if(blocksMovement(getBlock(Math.floor(player.x),Math.floor(ny+EYE_HEIGHT),Math.floor(player.z)))) player.velY=0;
        else player.y=ny;
      }
    }
    if(player.y < -30) respawnPlayer();
  }

  camera.position.set(player.x, player.y+EYE_HEIGHT, player.z);
  camera.rotation.set(player.pitch, player.yaw, 0);

  const t = getTarget();
  if(t){
    const [bx,by,bz]=t.target;
    highlight.position.set(bx+0.5,by+0.5,bz+0.5);
    highlight.visible = true;
  } else { highlight.visible = false; }

  renderer.render(scene, camera);
}

// ===================================================================
// Init
// ===================================================================
loadingOverlay.classList.remove('hidden');
requestAnimationFrame(() => setTimeout(() => {
  newWorld(Math.floor(Math.random()*1e9));
  loadingOverlay.classList.add('hidden');
  modeOverlay.classList.remove('hidden');
}, 20));
tick();

})();
