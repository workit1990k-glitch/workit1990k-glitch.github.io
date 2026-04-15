(function(){
'use strict';
if(window.mddxLoaded){return;}
window.mddxLoaded=true;

// ===== CONFIG =====
var API='https://api.mangadex.org';
var QUALITY='data-saver';
var MAX_ZIP=524288000;
var PAR_IMG=2;
var MAX_RETRIES=2;

// ===== HELPERS =====
function fmt(b){if(b<1024)return b+'B';if(b<1048576)return(b/1024).toFixed(1)+'KB';return(b/1048576).toFixed(2)+'MB';}
function sleep(ms){return new Promise(function(r){setTimeout(r,ms);});}

function apiGet(url){
  return fetch(url,{headers:{'Content-Type':'application/json'}}).then(function(r){
    if(r.ok) return r.json();
    return r.json().catch(function(){throw new Error('HTTP '+r.status);}).then(function(err){
      var msg='HTTP '+r.status;
      if(err&&err.errors&&err.errors[0]) msg=err.errors[0].detail||msg;
      throw new Error(msg);
    });
  });
}

function getMangaId(){
  var m=location.href.match(/mangadex\.org\/title\/([0-9a-f-]{36})/i);
  return m?m[1]:null;
}

// ===== CHAPTERS =====
function fetchChapters(mangaId){
  var chapters=[];
  var offset=0, limit=100;
  function nextPage(){
    var url=API+'/manga/'+mangaId+'/feed?limit='+limit+'&offset='+offset+'&order[chapter]=desc&translatedLanguage[]=en';
    return apiGet(url).then(function(res){
      var items=res.data||[];
      if(!items.length) return;
      for(var i=0;i<items.length;i++){
        var c=items[i], a=c.attributes;
        chapters.push({
          id:c.id,
          num:a.chapter||'0',
          title:a.title||'',
          groups:(a.groups||[]).map(function(g){return g.attributes?g.attributes.name:null;}).filter(Boolean).join(', ')
        });
      }
      if(items.length<limit) return;
      offset+=limit;
      return sleep(150).then(nextPage);
    });
  }
  return nextPage().then(function(){
    return chapters.sort(function(a,b){
      var na=parseFloat(a.num), nb=parseFloat(b.num);
      if(!isNaN(na)&&!isNaN(nb)) return na-nb;
      return String(a.num).localeCompare(String(b.num),undefined,{numeric:true});
    });
  });
}

// ===== IMAGES (with retry + headers) =====
var atHomeCache={}; // Cache at-home responses to avoid re-fetching

function fetchImages(cid,forceRefresh){
  if(!forceRefresh&&atHomeCache[cid]) return Promise.resolve(atHomeCache[cid]);
  
  return apiGet(API+'/at-home/server/'+cid).then(function(res){
    var ch=res.chapter||{};
    var base=res.baseUrl||'';
    var hash=ch.hash||'';
    var files=ch[QUALITY]||ch.data||[];
    var urls=files.map(function(f){return base+'/'+QUALITY+'/'+hash+'/'+f;});
    atHomeCache[cid]=urls;
    return urls;
  });
}

function dlImg(url,retryCount){
  retryCount=retryCount||0;
  return fetch(url,{
    headers:{
      'Referer':'https://mangadex.org/',
      'Origin':'https://mangadex.org'
    }
  }).then(function(r){
    if(r.ok) return r.blob();
    if(r.status===404&&retryCount<MAX_RETRIES){
      return sleep(200).then(function(){return dlImg(url,retryCount+1);});
    }
    throw new Error('HTTP '+r.status);
  });
}

// ===== LIBS =====
var JSZip=null, saveAs=null;
function loadLibs(){
  var loads=[];
  if(!JSZip){
    loads.push(new Promise(function(res,rej){
      var s=document.createElement('script');
      s.src='https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
      s.onload=function(){JSZip=window.JSZip;res();};
      s.onerror=rej;
      document.head.appendChild(s);
    }));
  }
  if(!saveAs){
    loads.push(new Promise(function(res,rej){
      var s=document.createElement('script');
      s.src='https://cdn.jsdelivr.net/npm/file-saver@2.0.5/dist/FileSaver.min.js';
      s.onload=function(){saveAs=window.saveAs;res();};
      s.onerror=rej;
      document.head.appendChild(s);
    }));
  }
  return Promise.all(loads);
}

// ===== UI =====
function createUI(){
  var ov=document.createElement('div');
  ov.id='mddx';
  ov.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,0.95);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;font-family:sans-serif;color:#fff;';
  ov.innerHTML='<div style="background:#1a1a2e;max-width:750px;width:100%;max-height:95vh;overflow:hidden;border-radius:10px;display:flex;flex-direction:column;">'+
    '<div style="padding:10px 14px;border-bottom:1px solid #333;display:flex;justify-content:space-between;"><strong>📚 MangaDex DL</strong><button id="mx" style="background:none;border:none;color:#aaa;font-size:18px;cursor:pointer;">&times;</button></div>'+
    '<div id="mb" style="flex:1;overflow:auto;padding:14px;"></div>'+
    '<div style="padding:10px 14px;border-top:1px solid #333;display:flex;gap:8px;flex-wrap:wrap;">'+
    '<button id="ma" style="padding:6px 14px;background:#333;border:none;border-radius:5px;color:#fff;cursor:pointer;">All</button>'+
    '<button id="mn" style="padding:6px 14px;background:#333;border:none;border-radius:5px;color:#fff;cursor:pointer;">None</button>'+
    '<span id="mc" style="margin-left:auto;color:#aaa;font-size:12px;">0 selected</span>'+
    '<button id="mf" disabled style="padding:6px 14px;background:#4a4;border:none;border-radius:5px;color:#fff;cursor:pointer;">📥 Fetch</button>'+
    '<button id="md" disabled style="padding:6px 14px;background:#48a;border:none;border-radius:5px;color:#fff;cursor:pointer;">💾 DL</button></div></div>';
  document.body.appendChild(ov);
  var close=function(){if(ov.parentNode)ov.parentNode.removeChild(ov);};
  document.getElementById('mx').onclick=close;
  ov.onclick=function(e){if(e.target===ov)close();};
  return{body:document.getElementById('mb'),cnt:document.getElementById('mc'),fetchBtn:document.getElementById('mf'),dlBtn:document.getElementById('md'),close:close};
}

function render(chapters,selected,cache){
  var frag=document.createDocumentFragment();
  for(var i=0;i<chapters.length;i++){
    var c=chapters[i];
    var div=document.createElement('div');
    div.style.cssText='padding:9px;background:#222;border-radius:7px;cursor:pointer;margin-bottom:6px;';
    if(cache[c.id])div.style.background=cache[c.id].failed>0?'#3a2525':'#253525';
    var cb=document.createElement('input');
    cb.type='checkbox';cb.checked=selected.has(c.id);cb.dataset.id=c.id;cb.style.cssText='margin-right:8px;cursor:pointer;';
    var info=document.createElement('div');info.style.display='inline-block';
    var status=cache[c.id]?(cache[c.id].failed>0?'<span style="color:#f66">⚠</span> ':'✓ ')+fmt(cache[c.id].size)+' ('+(cache[c.id].total-cache[c.id].failed)+'/'+cache[c.id].total+')':' ';
    info.innerHTML='<div style="font-weight:600">Ch.'+c.num+(c.title?' - '+c.title:'')+'</div><div style="font-size:10px;color:#aaa">'+(c.groups||'Unknown')+'</div><div style="font-size:9px;color:'+(cache[c.id]?(cache[c.id].failed>0?'#f66':'#4a4'):'#aaa')+'">'+status+'</div>';
    div.appendChild(cb);div.appendChild(info);
    div.onclick=function(e){if(e.target!==cb){cb.checked=!cb.checked;cb.onchange();}};
    cb.onchange=function(){var id=cb.dataset.id;if(cb.checked)selected.add(id);else selected.delete(id);updateCount(selected,cache);};
    frag.appendChild(div);
  }
  return frag;
}

function updateCount(selected,cache){
  var cnt=document.getElementById('mc'),fb=document.getElementById('mf'),db=document.getElementById('md');
  if(!cnt||!fb||!db)return;
  var fetched=0;
  selected.forEach(function(id){if(cache[id]&&cache[id].blobs&&cache[id].blobs.length)fetched++;});
  cnt.textContent=selected.size+' selected ('+fetched+' fetched)';
  fb.disabled=selected.size===0;db.disabled=fetched===0;
}

// ===== FETCH LOGIC (with retry fallback) =====
function fetchSelected(chapters,selected,cache,onProg){
  var todo=[];
  selected.forEach(function(id){var ch=chapters.find(function(c){return c.id===id;});if(ch&&!cache[ch.id])todo.push(ch);});
  var done=0;
  
  function processOne(idx){
    if(idx>=todo.length)return Promise.resolve();
    var ch=todo[idx];
    
    function tryFetch(refresh){
      return fetchImages(ch.id,refresh).then(function(urls){
        var blobs=[],size=0,failed=0;
        function dlBatch(bIdx){
          if(bIdx>=urls.length)return;
          var batch=[];
          for(var k=0;k<PAR_IMG&&bIdx+k<urls.length;k++) batch.push(dlImg(urls[bIdx+k]).catch(function(e){failed++;console.warn('Img '+ (bIdx+k+1) +': '+e.message);return null;}));
          return Promise.all(batch).then(function(results){
            for(var k=0;k<results.length;k++){
              var blob=results[k];
              if(blob){var n=bIdx+k+1;blobs.push({name:'page_'+String(n).padStart(3,'0')+'.jpg',blob:blob,size:blob.size});size+=blob.size;}
            }
            if(onProg)onProg(done,blobs.length,urls.length);
            return dlBatch(bIdx+PAR_IMG);
          });
        }
        return dlBatch(0).then(function(){
          if(failed>0&&!refresh){
            // Retry: refresh at-home server URLs for failed images
            atHomeCache[ch.id]=null;
            return tryFetch(true);
          }
          cache[ch.id]={blobs:blobs,size:size,total:urls.length,failed:failed};
          done++;if(onProg)onProg(done,0,0);
          return sleep(50).then(function(){return processOne(idx+1);});
        });
      });
    }
    
    return tryFetch(false).catch(function(err){
      console.warn('Chapter failed:',ch.num,err);
      cache[ch.id]={blobs:[],size:0,total:0,failed:0};
      done++;if(onProg)onProg(done,0,0);
      return sleep(50).then(function(){return processOne(idx+1);});
    });
  }
  return processOne(0);
}

// ===== DOWNLOAD =====
function downloadAll(chapters,selected,cache,title){
  return loadLibs().then(function(){
    var fetched=[];
    selected.forEach(function(id){var ch=chapters.find(function(c){return c.id===id;});if(ch&&cache[ch.id]&&cache[ch.id].blobs&&cache[ch.id].blobs.length)fetched.push(ch);});
    if(!fetched.length){alert('No fetched chapters to download');return;}
    var zip=new JSZip(),curSize=0,part=1;
    function saveZip(){
      if(curSize===0)return Promise.resolve();
      return zip.generateAsync({type:'blob',compression:'STORE'}).then(function(blob){
        saveAs(blob,title+'_part'+part+'.zip');part++;zip=new JSZip();curSize=0;
      });
    }
    function addChap(idx){
      if(idx>=fetched.length)return saveZip().then(function(){alert('✅ Download complete!');});
      var ch=fetched[idx],data=cache[ch.id];
      var fname='Ch.'+ch.num+(ch.title?' - '+ch.title:'');
      var folder=zip.folder(fname);
      for(var i=0;i<data.blobs.length;i++){var b=data.blobs[i];if(b&&b.name&&b.blob)folder.file(b.name,b.blob);}
      curSize+=data.size;
      if(curSize>=MAX_ZIP&&idx<fetched.length-1) return saveZip().then(function(){return addChap(idx+1);});
      return addChap(idx+1);
    }
    return addChap(0);
  });
}

// ===== INIT =====
function init(){
  var mid=getMangaId();
  if(!mid){alert('❌ Open a MangaDex manga page first');return;}
  var ui=createUI(),body=ui.body;
  body.innerHTML='<div style="text-align:center;padding:40px;color:#aaa;">⏳ Loading...</div>';
  
  apiGet(API+'/manga/'+mid).then(function(res){
    var m=res.data.attributes.title;
    var title=(m.en||m['ja-ro']||m.ja||'manga').replace(/[^a-z0-9]/gi,'').slice(0,35);
    return fetchChapters(mid).then(function(chapters){
      var selected=new Set(),cache={};
      body.innerHTML='';body.appendChild(render(chapters,selected,cache));
      document.getElementById('ma').onclick=function(){chapters.forEach(function(c){selected.add(c.id);});body.innerHTML='';body.appendChild(render(chapters,selected,cache));updateCount(selected,cache);};
      document.getElementById('mn').onclick=function(){selected.clear();body.innerHTML='';body.appendChild(render(chapters,selected,cache));updateCount(selected,cache);};
      ui.fetchBtn.onclick=function(){
        ui.fetchBtn.disabled=true;
        body.insertAdjacentHTML('beforeend','<div id="mp" style="padding:8px;background:#222;border-radius:5px;font-size:11px;color:#aaa;margin:8px 0;">⏳ Fetching...</div>');
        fetchSelected(chapters,selected,cache,function(cDone,cTot,iDone,iTot){
          var p=document.getElementById('mp');
          if(p){var t='📥 Ch '+cDone+'/'+cTot;if(iTot)t+=' | Img '+iDone+'/'+iTot;p.textContent=t;}
        }).then(function(){
          body.innerHTML='';body.appendChild(render(chapters,selected,cache));
          ui.fetchBtn.disabled=false;updateCount(selected,cache);
          var p=document.getElementById('mp');if(p)p.parentNode.removeChild(p);
          var totalFail=[...selected].reduce(function(sum,id){return sum+(cache[id]?cache[id].failed:0);},0);
          if(totalFail>0) alert('⚠️ '+totalFail+' images failed to download (may be expired or unavailable)');
        }).catch(function(err){alert('Fetch error: '+err.message);ui.fetchBtn.disabled=false;});
      };
      ui.dlBtn.onclick=function(){downloadAll(chapters,selected,cache,title);};
      updateCount(selected,cache);
    });
  }).catch(function(err){console.error(err);body.innerHTML='<div style="color:#f66;text-align:center;padding:20px;white-space:pre-wrap;">❌ '+err.message+'</div>';});
}

init();
})();
