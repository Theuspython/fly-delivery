import assert from 'node:assert/strict';
import {test} from 'node:test';
import {compactProfilePhoto,maxProfileBytes,validateProfilePhoto} from '../public/profile-photo.js';

async function browser(options,run) {
  const previous={document:globalThis.document,Image:globalThis.Image,create:URL.createObjectURL,revoke:URL.revokeObjectURL};
  const calls={draw:[],quality:[],created:0,revoked:0};
  const canvas={width:0,height:0,getContext:()=>({fillRect(){},drawImage(...args){calls.draw.push(args.slice(1));}}),
    toBlob(callback,type,quality){calls.quality.push(quality);queueMicrotask(()=>callback(options.encodeFailure?null:new Blob([new Uint8Array(options.sizes?.shift()??options.outputSize??80000)],{type})));}};
  globalThis.document={createElement(name){assert.equal(name,'canvas');return canvas;}};
  globalThis.Image=class {
    naturalWidth=options.width??4000;naturalHeight=options.height??3000;
    set src(value){if(value)queueMicrotask(()=>options.decodeFailure?this.onerror():this.onload());}
  };
  URL.createObjectURL=()=>{calls.created++;return 'blob:fixture';};URL.revokeObjectURL=()=>{calls.revoked++;};
  try {await run(calls,canvas);}finally{
    globalThis.document=previous.document;globalThis.Image=previous.Image;
    URL.createObjectURL=previous.create;URL.revokeObjectURL=previous.revoke;
  }
}
const source=()=>new File([new Uint8Array(5*1024*1024)],'camera.jpg',{type:'image/jpeg'});

test('a 5 MB profile source is cropped to the avatar and only a small JPEG is returned',async()=>{
  await browser({},async(calls,canvas)=>{
    const file=await compactProfilePhoto(source());
    assert.equal(file.type,'image/jpeg');assert.equal(file.name,'foto-perfil.jpg');assert.ok(file.size<=maxProfileBytes);
    assert.deepEqual(calls.draw[0],[500,0,3000,3000,0,0,512,512]);
    assert.equal(calls.created,1);assert.equal(calls.revoked,1);assert.equal(canvas.width,0);assert.equal(canvas.height,0);
  });
});
test('compression lowers quality and resolution to meet the byte cap without returning the original',async()=>{
  await browser({sizes:[260000,230000,210000,150000]},async calls=>{
    const file=await compactProfilePhoto(source());
    assert.equal(file.size,150000);assert.deepEqual(calls.quality,[.82,.68,.54,.82]);assert.equal(calls.draw.at(-1).at(-1),384);
  });
  await browser({outputSize:300000},async calls=>{
    await assert.rejects(compactProfilePhoto(source()),/reduzir esta foto/);
    assert.equal(calls.quality.length,9);assert.equal(calls.revoked,1);
  });
});
test('invalid sources, decode errors and failed encoding cannot upload an original or leak preview URLs',async()=>{
  assert.throws(()=>validateProfilePhoto(new File(['gif'],'file.gif',{type:'image/gif'})),/JPG/);
  assert.throws(()=>validateProfilePhoto(new File([new Uint8Array(20*1024*1024+1)],'big.jpg',{type:'image/jpeg'})),/20 MB/);
  for(const options of [{decodeFailure:true},{encodeFailure:true}])await browser(options,async calls=>{
    await assert.rejects(compactProfilePhoto(source()));assert.equal(calls.created,1);assert.equal(calls.revoked,1);
  });
});
