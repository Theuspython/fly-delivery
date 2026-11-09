export const maxProfileSourceBytes=20*1024*1024;
export const maxProfileBytes=50_000;
export function validateProfilePhoto(file) {
  if(!file?.size||!['image/jpeg','image/png','image/webp'].includes(file.type))throw new Error('Escolha uma foto JPG, PNG ou WebP.');
  if(file.size>maxProfileSourceBytes)throw new Error('Escolha uma foto de até 20 MB para compactar.');
}
export async function compactProfilePhoto(file) {
  validateProfilePhoto(file);
  const url=URL.createObjectURL(file),image=new Image(),canvas=document.createElement('canvas');
  let timer;
  try {
    image.decoding='async';
    await new Promise((resolve,reject)=>{
      image.onload=resolve;
      image.onerror=()=>reject(new Error('Não foi possível abrir esta foto. Escolha outra imagem.'));
      timer=setTimeout(()=>reject(new Error('A foto demorou para abrir. Tente outra imagem.')),20000);
      image.src=url;
    });
    clearTimeout(timer);
    const width=image.naturalWidth,height=image.naturalHeight;
    if(!width||!height||width*height>100000000)throw new Error('Esta foto tem uma resolução muito grande. Escolha uma versão menor.');
    const crop=Math.min(width,height),edge=Math.min(512,crop),context=canvas.getContext('2d');
    if(!context)throw new Error('Não foi possível compactar a foto neste navegador.');
    const encode=quality=>new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('Não foi possível compactar a foto.')),'image/jpeg',quality));
    for(const output of [...new Set([edge,Math.min(edge,384),Math.min(edge,256),Math.min(edge,192)])]){
      canvas.width=canvas.height=output;
      context.fillStyle='#ffffff';context.fillRect(0,0,output,output);
      context.imageSmoothingEnabled=true;context.imageSmoothingQuality='high';
      context.drawImage(image,(width-crop)/2,(height-crop)/2,crop,crop,0,0,output,output);
      for(const quality of [.82,.68,.54]){
        const blob=await encode(quality);
        if(blob.size<=maxProfileBytes&&blob.type==='image/jpeg')return new File([blob],'foto-perfil.jpg',{type:'image/jpeg',lastModified:Date.now()});
      }
    }
    throw new Error('Não foi possível reduzir esta foto. Escolha outra imagem.');
  } finally {
    clearTimeout(timer);image.onload=null;image.onerror=null;image.src='';
    URL.revokeObjectURL(url);canvas.width=canvas.height=0;
  }
}
