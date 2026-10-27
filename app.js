/* Browser MOT presentation. Physical coordinates and exported field names
 * deliberately match the retained Python experiment. No network requests. */
(() => {
  'use strict';
  const VERSION='1.0.0', STORAGE='mot-web-sessions-v1';
  const LOGICAL={width:1280,height:800}, MIN={width:1100,height:740};
  const PARAMS={trials_per_load:10,practice_trials:4,speed_px_s:160,tracking_duration_s:6,
    cue_duration_s:3,fixation_duration_s:.5,ball_radius_px:18,arena_width_px:1000,
    arena_height_px:560,target_counts:[3,4,5,6],physics_fixed_dt_s:1/240,
    rendering_engine:'browser_canvas',web_version:VERSION};
  const FIELDS=['session_id','participant','phase','trial_index','target_count','n_objects',
    'speed_px_s','targets','selections','hits','accuracy','exact','rt_s','seed','trial_seed',
    'data_source','tracking_duration_s','cue_duration_s','tracking_actual_s','n_frames',
    'dropped_frames','mean_frame_interval_s','max_frame_interval_s','refresh_hz'];
  const $=id=>document.getElementById(id);
  const canvas=$('experiment-canvas'), ctx=canvas.getContext('2d');
  const query=new URLSearchParams(location.search);
  const testAuto=query.get('demo')==='1' && query.get('autoplay')==='1';
  let session=null, resultSession=null, schedule=[], trial=null, world=null, targets=[], selected=[];
  let active=false, phase='welcome', phaseStarted=null, trackStarted=null, selectionStarted=null;
  let lastPhysics=0,lastTrackFrame=null,intervals=[],actualTracking=0,trialCursor=0,refreshHz=60;
  let raf=null,messageAction=null,lockedViewport=null,calibration=[],calibrationPrevious=null;
  let sessionDemo=false,automatic=false,feedbackText='',saveWarning=false;
  const round=v=>Math.round(v*1e6)/1e6;
  function randomInteger(){const a=new Uint32Array(1);crypto.getRandomValues(a);return a[0]&0x7fffffff;}
  function identifier(){const a=new Uint32Array(2);crypto.getRandomValues(a);return Array.from(a,n=>n.toString(16).padStart(8,'0')).join('');}
  function viewport(){return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio||1};}
  function deviceOK(){return innerWidth>=MIN.width && innerHeight>=MIN.height && !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);}
  function readiness(){
    const ready=deviceOK();$('device-status').textContent=ready?'显示区域已就绪。请保持当前窗口大小。':`当前可视区域 ${innerWidth} × ${innerHeight}，请使用电脑并进入全屏，至少需要 ${MIN.width} × ${MIN.height}。`;
    $('device-status').classList.toggle('bad',!ready);
  }
  function records(){try{return JSON.parse(localStorage.getItem(STORAGE)||'[]');}catch{return [];}}
  function persist(){
    if(!session)return;
    try{let saved=records().filter(s=>s.metadata.session_id!==session.metadata.session_id);saved.push(session);localStorage.setItem(STORAGE,JSON.stringify(saved.slice(-8)));}
    catch{saveWarning=true;}
  }
  function recoverRecords(){
    try{const saved=records();let changed=false;for(const item of saved){if(item.metadata.status==='running'){
      item.metadata.status='aborted';item.metadata.finished_at=new Date().toISOString();item.metadata.notes+=' Page closed or reloaded before completion.';changed=true;
    }}if(changed)localStorage.setItem(STORAGE,JSON.stringify(saved));}catch{}
  }
  function recent(){
    const saved=records().reverse();$('recent-section').hidden=!saved.length;const list=$('recent-list');list.replaceChildren();
    for(const item of saved){const row=document.createElement('div');row.className='recent-row';const text=document.createElement('span');
      const m=item.metadata;text.textContent=`${m.participant} · ${m.data_source==='simulation'?'演示 / ':''}${m.status==='complete'?'已完成':'已中止'} · 正式 ${m.completed_formal_trials}/${m.planned_formal_trials} 次`;
      const button=document.createElement('button');button.type='button';button.className='text-button';button.textContent='查看与下载';button.addEventListener('click',()=>showResult(item));row.append(text,button);list.append(row);
    }
  }
  function showWelcome(){
    $('welcome').hidden=false;$('stage').hidden=true;$('result-panel').hidden=true;phase='welcome';resultSession=null;readiness();recent();window.scrollTo(0,0);
  }
  function fitCanvas(){
    const scale=Math.min(innerWidth/LOGICAL.width,innerHeight/LOGICAL.height);
    canvas.style.width=`${LOGICAL.width*scale}px`;canvas.style.height=`${LOGICAL.height*scale}px`;
    const dpr=devicePixelRatio||1;canvas.width=Math.round(LOGICAL.width*dpr);canvas.height=Math.round(LOGICAL.height*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);
  }
  function note(text){$('live-status').textContent=text;}
  function clear(){ctx.fillStyle='#2d2d2d';ctx.fillRect(0,0,1280,800);}
  function text(value,x,y,size=24,color='#f0f2f1',align='center'){
    ctx.font=`${size}px "Microsoft YaHei","Segoe UI",sans-serif`;ctx.fillStyle=color;ctx.textAlign=align;ctx.textBaseline='middle';ctx.fillText(value,x,y);
  }
  function drawWorld(instruction,mode='normal',blink=false){
    clear();ctx.fillStyle='#181818';ctx.fillRect(140,120,1000,560);ctx.strokeStyle='#8b8e8c';ctx.lineWidth=2;ctx.strokeRect(140,120,1000,560);
    const heading=`${sessionDemo?'流程演示（非实测） · ':''}${trial.phase==='practice'?'练习':'正式'} ${trial.trial_index} / ${trial.phase==='practice'?session.metadata.parameters.practice_trials:session.metadata.planned_formal_trials}    目标 ${trial.target_count} 个`;
    text(heading,640,69,25);
    world.positions.forEach((p,i)=>{
      ctx.fillStyle=mode==='cue'&&blink&&targets.includes(i)?'#ff6262':mode==='selection'&&selected.includes(i)?'#65c8ff':mode==='feedback'&&targets.includes(i)?'#65d58c':'#efefef';
      ctx.beginPath();ctx.arc(640+p[0],400-p[1],18,0,Math.PI*2);ctx.fill();
    });
    text(instruction,640,739,21);
  }
  function showMessage(eyebrow,title,body,label,action){
    phase='message';phaseStarted=null;messageAction=action;
    $('message-eyebrow').textContent=sessionDemo?'流程演示 · 不计入实测':eyebrow;
    $('message-title').textContent=title;$('message-body').textContent=body;$('message-button').textContent=label;
    $('message-button').disabled=!action;$('message-overlay').hidden=false;note(title);
    if(automatic&&action)setTimeout(()=>{if(active&&phase==='message'&&messageAction===action)advanceMessage();},80);
  }
  function advanceMessage(){if(!active||!messageAction)return;const action=messageAction;messageAction=null;$('message-overlay').hidden=true;action();}
  function setPhase(value){phase=value;phaseStarted=null;}
  function scheduleNext(){
    if(trialCursor>=schedule.length){complete();return;}
    const next=schedule[trialCursor];
    if(next.phase==='formal'&&(trial===null||trial.phase==='practice')){
      showMessage('正式测试', '练习结束',`接下来共 ${session.metadata.planned_formal_trials} 次正式测试。每 10 次可以休息。\n正式测试只提示已记录，请尽量准确地追踪目标。`,'开始正式测试',beginTrial);return;
    }
    if(trial&&trial.phase==='formal'&&trial.trial_index%10===0){
      showMessage('休息片刻','这一组完成了','保持当前页面和窗口大小。\n准备好后点击下方按钮，或按空格继续。','继续测试',beginTrial);return;
    }
    beginTrial();
  }
  function beginTrial(){
    trial=schedule[trialCursor];world=MOTCore.ElasticWorld.random(trial.trial_seed,session.metadata.parameters.speed_px_s);
    const rng=MOTCore.createRng((trial.trial_seed^0x51f15e)>>>0);const identities=[0,1,2,3,4,5,6,7];
    for(let i=identities.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[identities[i],identities[j]]=[identities[j],identities[i]];}
    targets=identities.slice(0,trial.target_count).sort((a,b)=>a-b);selected=[];intervals=[];lastPhysics=0;lastTrackFrame=null;actualTracking=0;
    canvas.style.cursor='none';setPhase('fixation');note(`${trial.phase==='practice'?'练习':'正式测试'}，目标 ${trial.target_count} 个`);
  }
  function saveTrial(rt){
    const p=session.metadata.parameters;const scored=MOTCore.scoreSelection(targets,selected);
    session.trials.push({session_id:session.metadata.session_id,participant:session.metadata.participant,
      phase:trial.phase,trial_index:trial.trial_index,target_count:trial.target_count,n_objects:8,
      speed_px_s:p.speed_px_s,targets:JSON.stringify(targets),selections:JSON.stringify([...selected].sort((a,b)=>a-b)),...scored,
      rt_s:round(Math.max(rt,.000001)),seed:session.metadata.seed,trial_seed:trial.trial_seed,data_source:session.metadata.data_source,
      tracking_duration_s:p.tracking_duration_s,cue_duration_s:p.cue_duration_s,tracking_actual_s:round(actualTracking),
      n_frames:intervals.length,dropped_frames:intervals.filter(v=>v>1.5/refreshHz).length,
      mean_frame_interval_s:round(intervals.reduce((a,b)=>a+b,0)/intervals.length),
      max_frame_interval_s:round(Math.max(...intervals)),refresh_hz:round(refreshHz)});
    session.metadata[`completed_${trial.phase}_trials`]++;persist();
    feedbackText=trial.phase==='practice'?`命中 ${scored.hits} / ${trial.target_count} 个目标`:'已记录';
    canvas.style.cursor='none';setPhase('feedback');
  }
  function frame(t){
    if(!active)return;
    try{
      if(phase==='calibration'){
        if(calibrationPrevious!==null)calibration.push((t-calibrationPrevious)/1000);calibrationPrevious=t;
        if(calibration.length>=50){
          const stable=calibration.slice(10).sort((a,b)=>a-b);const mid=stable[Math.floor(stable.length/2)];
          refreshHz=1/mid;if(!Number.isFinite(refreshHz)||refreshHz<30||refreshHz>400){abort('屏幕刷新状态不稳定，请关闭其他繁忙程序后重新测试。');return;}
          session.metadata.refresh_hz=round(refreshHz);session.metadata.refresh_estimated=false;persist();
          showMessage('正式测试前','先完成练习','记住闪烁的小球，在同色运动时持续追踪。\n停下后用鼠标选择目标；再次点击可以取消。\n选够提示的数量后，按空格提交。\n\n练习会显示原目标和命中数。',sessionDemo?'开始流程演示':'开始练习',scheduleNext);
        }
      }else if(['fixation','cue','tracking','selection','feedback'].includes(phase)){
        if(phaseStarted===null)phaseStarted=t;
        const p=session.metadata.parameters, elapsed=(t-phaseStarted)/1000;
        if(phase==='fixation'){
          clear();text('+',640,400,28);
          if(elapsed>=p.fixation_duration_s){phase='cue';phaseStarted=t;drawWorld('记住闪烁的目标','cue',true);}
        }else if(phase==='cue'){
          drawWorld('记住闪烁的目标','cue',Math.floor(elapsed*4)%2===0);
          if(elapsed>=p.cue_duration_s){phase='tracking';phaseStarted=t;trackStarted=t;lastTrackFrame=t;drawWorld('持续追踪刚才的目标');}
        }else if(phase==='tracking'){
          const dt=(t-lastTrackFrame)/1000;
          if(dt>.25){abort('追踪期间出现较长的画面停顿，请关闭其他繁忙程序后重新测试。');return;}
          intervals.push(dt);lastTrackFrame=t;
          const trajectory=Math.min((t-trackStarted)/1000,p.tracking_duration_s);
          world.advance(Math.max(0,trajectory-lastPhysics));lastPhysics=trajectory;
          drawWorld('持续追踪刚才的目标');
          if(trajectory>=p.tracking_duration_s){
            actualTracking=(t-trackStarted)/1000;phase='selection';phaseStarted=t;selectionStarted=t;canvas.style.cursor='crosshair';
            drawWorld(`选择 ${trial.target_count} 个原目标，然后按空格提交；已选 0 / ${trial.target_count}`,'selection');note(`运动已停止，请选择 ${trial.target_count} 个目标。`);
          }
        }else if(phase==='selection'){
          drawWorld(`选择 ${trial.target_count} 个原目标，然后按空格提交；已选 ${selected.length} / ${trial.target_count}`,'selection');
          if(automatic&&t-selectionStarted>120){selected=[...targets];saveTrial((t-selectionStarted)/1000);}
        }else if(phase==='feedback'){
          drawWorld(feedbackText,trial.phase==='practice'?'feedback':'normal');
          if(elapsed>=(sessionDemo?.2:1)){trialCursor++;scheduleNext();}
        }
      }
    }catch(error){abort(`程序发生异常：${error.message}`,'error');return;}
    if(active)raf=requestAnimationFrame(frame);
  }
  function start(demo=false){
    $('start-error').textContent='';if(!window.MOTCore){$('start-error').textContent='实验文件未加载完整，请刷新页面。';return;}
    if(!deviceOK()&&!(demo&&innerWidth>=900&&innerHeight>=600)){$('start-error').textContent='请先使用电脑并进入全屏，达到页面提示的显示区域后再开始。';return;}
    const sid=demo?'DEMO':$('participant').value.trim().toUpperCase();
    if(!/^[A-Za-z][A-Za-z0-9_-]{0,23}$/.test(sid)){$('start-error').textContent='请填写有效编号，例如 P01。';return;}
    if(!demo&&!$('consent').checked){$('start-error').textContent='请先阅读任务说明并勾选自愿参与。';return;}
    sessionDemo=demo;automatic=demo&&testAuto;saveWarning=false;
    const seed=randomInteger(),id=identifier(),stamp=new Date().toISOString().replace(/[-:]/g,'').replace(/\..*$/,'').replace('T','_');
    const parameters={...PARAMS};if(demo)Object.assign(parameters,{trials_per_load:1,practice_trials:1,fixation_duration_s:.1,cue_duration_s:.5,tracking_duration_s:1.2});
    const stem=`${sid}_${stamp}_${id}`;
    session={format:'mot-web-session',schema_version:1,metadata:{
      session_id:id,participant:sid,data_source:demo?'simulation':'human',status:'running',
      started_at:new Date().toISOString(),parameters,seed,csv_file:`${stem}_trials.csv`,
      planned_formal_trials:parameters.trials_per_load*4,completed_formal_trials:0,completed_practice_trials:0,
      random_algorithm:MOTCore.PRNG_ALGORITHM,rendering_engine:'browser_canvas',web_version:VERSION,
      user_agent:navigator.userAgent,language:navigator.language,screen_size_css:[screen.width,screen.height],
      viewport_css:[innerWidth,innerHeight],device_pixel_ratio:devicePixelRatio||1,
      canvas_logical_size:[1280,800],canvas_scale:Math.min(innerWidth/1280,innerHeight/800),
      timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'unknown',fullscreen:!!document.fullscreenElement,
      quality_events:[],notes:demo?'Flow demonstration only; not empirical data.':'Browser remote session; results downloaded manually.'},trials:[]};
    schedule=MOTCore.buildSchedule(seed,parameters.trials_per_load,parameters.practice_trials);
    trialCursor=0;trial=null;world=null;selected=[];lockedViewport=viewport();calibration=[];calibrationPrevious=null;active=true;
    $('welcome').hidden=true;$('result-panel').hidden=true;$('stage').hidden=false;fitCanvas();
    showMessage('准备屏幕','正在检查显示状态','请保持当前页面，片刻后开始。','准备中…',null);phase='calibration';persist();raf=requestAnimationFrame(frame);
  }
  function complete(){
    active=false;cancelAnimationFrame(raf);session.metadata.status='complete';session.metadata.finished_at=new Date().toISOString();persist();showResult(session);
  }
  function abort(reason,status='aborted'){
    if(!active)return;active=false;cancelAnimationFrame(raf);messageAction=null;
    session.metadata.status=status;session.metadata.finished_at=new Date().toISOString();session.metadata.notes+=` ${reason}`;
    session.metadata.quality_events.push({type:status,reason,at:new Date().toISOString(),phase,trial:trial?.trial_index??null});persist();showResult(session);
  }
  function showResult(item){
    resultSession=item;active=false;phase='result';$('welcome').hidden=true;$('stage').hidden=true;$('result-panel').hidden=false;
    const m=item.metadata,complete=m.status==='complete',demo=m.data_source==='simulation';
    $('result-tag').textContent=demo?'流程演示 · 非实测':complete?'测试已完成':'本次测试已中止';
    $('result-title').textContent=demo?'演示结束，熟悉流程了吗？':complete?'谢谢参与，请下载结果。':'已保留完成的试次。';
    $('result-description').textContent=demo?'这份记录为演示数据，不能作为受试结果。返回首页后可填写编号，开始正式测试。':complete?'请点击下方按钮下载完整结果 JSON，并把它发给实验组织者。\n下载后请保留原文件名。':`本次记录不满足完整测试条件，不能用于正式分析。\n原因：${m.quality_events?.at(-1)?.reason||m.notes||'会话未完整结束'}\n请联系实验组织者，确认后重新完成测试。`;
    const summary=$('result-summary');summary.replaceChildren();
    for(const [value,label]of[[m.participant,'受试编号'],[`${m.completed_formal_trials} / ${m.planned_formal_trials}`,'正式试次'],[m.completed_practice_trials,'练习试次']]){
      const div=document.createElement('div');div.className='summary-item';const b=document.createElement('b');b.textContent=value;const span=document.createElement('span');span.textContent=label;div.append(b,span);summary.append(div);
    }
    $('download-notice').textContent=saveWarning?'此浏览器无法保存进度备份，请现在下载结果。':'结果已在此浏览器保留，可返回首页再次下载。';window.scrollTo(0,0);
  }
  function download(kind){
    if(!resultSession)return;const m=resultSession.metadata;const stem=m.csv_file.replace(/_trials\.csv$/,'');let data,name,type;
    if(kind==='json'){data=JSON.stringify(resultSession,null,2);name=`${stem}_session.json`;type='application/json;charset=utf-8';}
    else{
      const escape=v=>`"${String(v??'').replace(/"/g,'""')}"`;
      data='\uFEFF'+[FIELDS.map(escape).join(','),...resultSession.trials.map(row=>FIELDS.map(k=>escape(row[k])).join(','))].join('\r\n');name=`${stem}_trials.csv`;type='text/csv;charset=utf-8';
    }
    const url=URL.createObjectURL(new Blob([data],{type}));const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
    $('download-notice').textContent=`已请求下载 ${name}。请确认文件已出现在浏览器下载列表。`;
  }
  $('start-form').addEventListener('submit',e=>{e.preventDefault();start(false);});
  $('demo-button').addEventListener('click',()=>start(true));
  $('fullscreen-button').addEventListener('click',async()=>{try{if(!document.fullscreenElement)await document.documentElement.requestFullscreen();readiness();}catch{$('start-error').textContent='无法进入全屏，请手动将浏览器最大化或使用浏览器全屏功能。';}});
  $('message-button').addEventListener('click',advanceMessage);$('stop-button').addEventListener('click',()=>abort('参与者主动结束本次测试。'));
  $('download-json').addEventListener('click',()=>download('json'));$('download-csv').addEventListener('click',()=>download('csv'));$('back-button').addEventListener('click',showWelcome);
  canvas.addEventListener('pointerdown',e=>{
    if(!active||phase!=='selection'||e.button!==0||e.pointerType==='touch')return;e.preventDefault();
    const rect=canvas.getBoundingClientRect(),x=(e.clientX-rect.left)*1280/rect.width-640,y=400-(e.clientY-rect.top)*800/rect.height;
    const i=world.positions.findIndex(p=>Math.hypot(x-p[0],y-p[1])<=18);if(i<0)return;
    if(selected.includes(i))selected=selected.filter(v=>v!==i);else if(selected.length<trial.target_count)selected.push(i);
    note(`已选择 ${selected.length} / ${trial.target_count} 个目标`);
  });
  document.addEventListener('keydown',e=>{
    if(!active)return;if(e.code==='Escape'){e.preventDefault();abort('参与者按 Esc 结束本次测试。');return;}
    if(e.code==='Space'){e.preventDefault();if(e.repeat)return;
      if(phase==='message')advanceMessage();else if(phase==='selection'&&selected.length===trial.target_count)saveTrial((performance.now()-selectionStarted)/1000);
    }
  });
  document.addEventListener('visibilitychange',()=>{if(document.hidden&&active)abort('测试中切换了标签页或页面进入后台，请重新测试。');});
  window.addEventListener('blur',()=>{if(active)abort('测试窗口失去焦点，请重新测试。');});
  window.addEventListener('resize',()=>{
    readiness();if(active&&lockedViewport){const v=viewport();if(v.width!==lockedViewport.width||v.height!==lockedViewport.height||v.dpr!==lockedViewport.dpr)abort('测试中改变了窗口大小或缩放比例，请重新测试。');}
  });
  window.addEventListener('beforeunload',e=>{if(active){persist();e.preventDefault();e.returnValue='';}});
  window.addEventListener('pagehide',()=>{if(active)abort('测试页面在完成前关闭。');});
  // Test automation can only start a visibly labelled simulation and never
  // turns simulated selections into human data.
  Object.defineProperty(window,'MOT_TEST_STATE',{get:()=>({phase,active,session:session?JSON.parse(JSON.stringify(session)):null,
    trial:trial?{...trial}:null,selected:[...selected],positions:world?world.positions.map(p=>[...p]):null,targets:sessionDemo?[...targets]:undefined})});
  recoverRecords();showWelcome();
})();
