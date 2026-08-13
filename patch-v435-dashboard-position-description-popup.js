/* CNMI Staff Planner V435
 * Dashboard daytime-position quick description.
 * - Makes each position name in "ตำแหน่งกลางวันวันนี้" tappable/clickable.
 * - Opens a compact mobile-friendly summary with up to 3 main-duty bullets + break time.
 * - "ดูคำอธิบายตำแหน่งฉบับเต็ม" opens the complete duty detail without leaving Dashboard.
 * - Uses the current Slot metadata source when available (V381), with safe fallbacks.
 * - Display-only. No Supabase query/write/schema changes.
 */
(function(){
  'use strict';

  const VERSION='V435_DASHBOARD_POSITION_DESCRIPTION_POPUP';
  if(window.__CNMI_V435_DASHBOARD_POSITION_DESCRIPTION_POPUP__)return;
  window.__CNMI_V435_DASHBOARD_POSITION_DESCRIPTION_POPUP__=true;

  function S(){try{return window.state||state||{};}catch(_){return window.state||{};}}
  function text(v){return String(v==null?'':v).trim();}
  function esc(v){
    try{if(typeof escapeHtml==='function')return escapeHtml(v==null?'':String(v));}catch(_){ }
    return String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function today(){
    try{return typeof todayStr==='function'?todayStr():'';}catch(_){ }
    const d=new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
  function codeOf(row){return text(row?.position_code||row?.code);}
  function keyOf(v){return text(v).replace(/\s+/g,'').toLowerCase();}
  function useful(v){const s=text(v);return !!s&&!['-','--','—'].includes(s)&&!/ยังไม่ได้ระบุ|รอตรวจสอบ/i.test(s);}

  function labelOf(row){
    const code=codeOf(row)||'ตำแหน่ง';
    try{if(typeof positionLabelForCell==='function')return text(positionLabelForCell(code))||code;}catch(_){ }
    try{if(typeof labelCode==='function')return text(labelCode(code))||code;}catch(_){ }
    return code;
  }
  function zoneOf(row){
    try{return text(window.cnmiDashboardPositionsV434?.zoneOf?.(row))||text(row?.zone)||'-';}catch(_){return text(row?.zone)||'-';}
  }

  function masterFor(code){
    const key=keyOf(code);
    for(const list of [S()?.positionMasters,S()?.dailyPositionMasters]){
      if(!Array.isArray(list))continue;
      const found=list.find(row=>keyOf(codeOf(row))===key&&row?.is_active!==false&&!row?.deleted_at);
      if(found)return found;
    }
    try{if(typeof positionByCode==='function')return positionByCode(code)||null;}catch(_){ }
    return null;
  }

  function metadataFor(row,date){
    let current={};
    try{current=window.cnmiV381?.metadataFor?.(row,date)||{};}catch(_){current={};}
    const master=masterFor(codeOf(row))||{};
    let detail='';
    try{detail=text(window.cnmiV378?.detailOf?.(row,null));}catch(_){detail='';}
    return {
      zone: useful(current?.zone)?text(current.zone):(useful(row?.zone)?text(row.zone):(useful(master?.zone)?text(master.zone):zoneOf(row))),
      break_time: useful(current?.break_time)?text(current.break_time):(useful(row?.break_time)?text(row.break_time):(useful(master?.break_time)?text(master.break_time):'-')),
      main_rule: useful(current?.main_rule)?text(current.main_rule):(useful(row?.main_rule||row?.required_role)?text(row.main_rule||row.required_role):(useful(master?.main_rule||master?.required_role)?text(master.main_rule||master.required_role):'-')),
      job_desc: useful(current?.job_desc)?text(current.job_desc):(useful(row?.job_desc||row?.description)?text(row.job_desc||row.description):(useful(master?.job_desc||master?.description)?text(master.job_desc||master.description):(useful(detail)?detail:`ปฏิบัติงานตามหน้าที่ของตำแหน่ง ${codeOf(row)||'ที่ได้รับมอบหมาย'}`)))
    };
  }

  function rowsFor(date){
    try{
      const api=window.cnmiDashboardPositionsV434;
      if(api?.rowsFor&&api?.groupRows){
        const rows=api.rowsFor(date)||[];
        const groups=api.groupRows(rows)||[];
        return groups.flatMap(group=>Array.isArray(group?.[1])?group[1]:[]);
      }
    }catch(_){ }
    return (S()?.positions||[]).filter(row=>text(row?.work_date).slice(0,10)===date&&codeOf(row));
  }

  function splitMainDuties(job){
    const source=text(job).replace(/\r/g,'\n');
    if(!source)return[];
    let parts=source.split(/\n+|[•;]|,(?=\s|$)/).map(v=>text(v)).filter(Boolean);
    if(parts.length<2){
      parts=source.split(/\s+และ(?=การ|งาน|ทำ|ตรวจ|รับ|บันทึก|ดูแล|แจ้ง|นำ|จ่าย|เตรียม|ปั่น)/).map(v=>text(v)).filter(Boolean);
    }
    const clean=[];
    for(const part of parts){
      const item=part.replace(/^[\-–—•\s]+/,'').trim();
      if(item&&!clean.some(x=>x===item))clean.push(item);
    }
    return (clean.length?clean:[source]).slice(0,3);
  }

  function rowByIndex(index,date){
    const list=rowsFor(date);
    const row=list[Number(index)];
    return row||null;
  }

  function showSummary(row,date,index){
    if(!row)return;
    const meta=metadataFor(row,date);
    const duties=splitMainDuties(meta.job_desc);
    const dutyHtml=duties.map(item=>`<li>${esc(item)}</li>`).join('');
    const breakText=meta.break_time==='-'?'-':`${meta.break_time}${/^\d{1,2}:\d{2}$/.test(meta.break_time)?' น.':''}`;
    showModal(`
      <div class="v435-position-summary-modal" data-v435-row-index="${Number(index)}" data-v435-date="${esc(date)}">
        <div class="v435-modal-heading">
          <div>
            <h2>${esc(labelOf(row))}</h2>
            <span class="v435-zone-badge">${esc(meta.zone||zoneOf(row))}</span>
          </div>
        </div>
        <section class="v435-main-duty-box">
          <h3>หน้าที่หลัก</h3>
          <ul>${dutyHtml}</ul>
          <div class="v435-break-row"><span>เวลาพัก</span><b>${esc(breakText)}</b></div>
        </section>
        <button type="button" class="soft-btn v435-full-detail-btn" data-v435-full-detail="${Number(index)}" data-v435-date="${esc(date)}">ดูคำอธิบายตำแหน่งฉบับเต็ม</button>
      </div>
    `,{small:true});
  }

  function showFull(row,date,index){
    if(!row)return;
    const meta=metadataFor(row,date);
    const breakText=meta.break_time==='-'?'-':`${meta.break_time}${/^\d{1,2}:\d{2}$/.test(meta.break_time)?' น.':''}`;
    showModal(`
      <div class="v435-position-full-modal" data-v435-row-index="${Number(index)}" data-v435-date="${esc(date)}">
        <div class="v435-modal-heading">
          <div>
            <h2>${esc(labelOf(row))}</h2>
            <span class="v435-zone-badge">${esc(meta.zone||zoneOf(row))}</span>
          </div>
        </div>
        <div class="v435-full-meta-grid">
          <div><small>เวลาพัก</small><b>${esc(breakText)}</b></div>
          <div><small>ผู้ปฏิบัติหลัก / เงื่อนไข</small><b>${esc(meta.main_rule||'-')}</b></div>
        </div>
        <section class="v435-full-duty-box">
          <h3>รายละเอียดหน้าที่ที่ต้องทำ</h3>
          <p>${esc(meta.job_desc||'-')}</p>
        </section>
        <button type="button" class="soft-btn v435-back-summary-btn" data-v435-back-summary="${Number(index)}" data-v435-date="${esc(date)}">กลับหน้าที่หลัก</button>
      </div>
    `,{small:true});
  }

  function decorateCard(card,date){
    if(!card)return;
    const rows=rowsFor(date);
    const items=Array.from(card.querySelectorAll('.v434-position-item'));
    items.forEach((item,index)=>{
      const row=rows[index];
      const codeNode=item.querySelector('.v434-position-code');
      if(!row||!codeNode)return;
      codeNode.dataset.v435PositionOpen=String(index);
      codeNode.dataset.v435Date=date;
      codeNode.setAttribute('role','button');
      codeNode.setAttribute('tabindex','0');
      codeNode.setAttribute('aria-label',`ดูหน้าที่ตำแหน่ง ${labelOf(row)}`);
      codeNode.title='แตะดูหน้าที่ตำแหน่ง';
      codeNode.classList.add('v435-position-link');
      if(!codeNode.querySelector('.v435-info-mark')){
        const mark=document.createElement('span');
        mark.className='v435-info-mark';
        mark.textContent='i';
        mark.setAttribute('aria-hidden','true');
        codeNode.appendChild(mark);
      }
    });
    card.dataset.v435PositionDescriptions='1';
  }

  function decorateDashboard(root=document){
    const date=today();
    root.querySelectorAll?.('[data-v434-daytime-positions]').forEach(card=>decorateCard(card,date));
  }

  function decorateHtml(html){
    try{
      const tpl=document.createElement('template');
      tpl.innerHTML=String(html||'');
      decorateDashboard(tpl.content);
      const holder=document.createElement('div');
      holder.appendChild(tpl.content.cloneNode(true));
      return holder.innerHTML;
    }catch(err){
      console.warn(`[${VERSION}] dashboard HTML decoration skipped`,err);
      return html;
    }
  }

  const previousDashboard=window.renderDashboard||(typeof renderDashboard==='function'?renderDashboard:null);
  if(typeof previousDashboard==='function'&&!previousDashboard.__v435Wrapped){
    const wrapped=function renderDashboardV435(){
      return decorateHtml(previousDashboard.apply(this,arguments));
    };
    wrapped.__v435Wrapped=true;
    try{window.renderDashboard=renderDashboard=wrapped;}catch(_){window.renderDashboard=wrapped;}
  }

  let queued=false;
  function queue(){
    if(queued)return;
    queued=true;
    requestAnimationFrame(()=>{queued=false;decorateDashboard(document);});
  }

  const root=document.getElementById('pageContent')||document.body;
  if(root&&!root.__v435DashboardPositionObserver){
    const observer=new MutationObserver(queue);
    observer.observe(root,{childList:true,subtree:true});
    root.__v435DashboardPositionObserver=observer;
  }

  document.addEventListener('click',event=>{
    const open=event.target?.closest?.('[data-v435-position-open]');
    if(open){
      event.preventDefault();
      event.stopPropagation();
      const index=Number(open.dataset.v435PositionOpen);
      const date=text(open.dataset.v435Date)||today();
      showSummary(rowByIndex(index,date),date,index);
      return;
    }
    const full=event.target?.closest?.('[data-v435-full-detail]');
    if(full){
      event.preventDefault();
      event.stopPropagation();
      const index=Number(full.dataset.v435FullDetail);
      const date=text(full.dataset.v435Date)||today();
      showFull(rowByIndex(index,date),date,index);
      return;
    }
    const back=event.target?.closest?.('[data-v435-back-summary]');
    if(back){
      event.preventDefault();
      event.stopPropagation();
      const index=Number(back.dataset.v435BackSummary);
      const date=text(back.dataset.v435Date)||today();
      showSummary(rowByIndex(index,date),date,index);
    }
  },true);

  document.addEventListener('keydown',event=>{
    if(event.key!=='Enter'&&event.key!==' ')return;
    const open=event.target?.closest?.('[data-v435-position-open]');
    if(!open)return;
    event.preventDefault();
    const index=Number(open.dataset.v435PositionOpen);
    const date=text(open.dataset.v435Date)||today();
    showSummary(rowByIndex(index,date),date,index);
  },true);

  const style=document.createElement('style');
  style.id='cnmi-v435-dashboard-position-description-popup';
  style.textContent=`
    .v434-position-code.v435-position-link{display:flex;align-items:center;gap:5px;width:max-content;max-width:100%;cursor:pointer;touch-action:manipulation;outline:none}
    .v434-position-code.v435-position-link:hover{color:#1677ae}
    .v434-position-code.v435-position-link:focus-visible{border-radius:7px;box-shadow:0 0 0 3px rgba(42,157,208,.18)}
    .v435-info-mark{display:inline-flex;flex:0 0 auto;align-items:center;justify-content:center;width:15px;height:15px;border-radius:999px;background:#e9f5fb;color:#1682b8;border:1px solid #bfe2f2;font-size:10px;font-weight:900;font-family:Arial,sans-serif;line-height:1}
    .v435-position-summary-modal,.v435-position-full-modal{padding:2px 0 0}
    .v435-modal-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding-right:34px;margin-bottom:14px}
    .v435-modal-heading h2{margin:0 0 7px;color:#20364d;font-size:22px;line-height:1.25;overflow-wrap:anywhere}
    .v435-zone-badge{display:inline-flex;align-items:center;border-radius:999px;padding:5px 10px;background:#edf6ff;color:#28648f;border:1px solid #d1e7fa;font-size:11px;font-weight:850}
    .v435-main-duty-box,.v435-full-duty-box{border:1px solid #dce8f3;border-radius:16px;background:#f9fcff;padding:14px 15px}
    .v435-main-duty-box h3,.v435-full-duty-box h3{margin:0 0 9px;color:#20364d;font-size:16px}
    .v435-main-duty-box ul{margin:0;padding-left:22px;color:#3c5369}
    .v435-main-duty-box li{margin:0 0 7px;line-height:1.5;overflow-wrap:anywhere}
    .v435-main-duty-box li:last-child{margin-bottom:0}
    .v435-break-row{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-top:12px;padding-top:11px;border-top:1px solid #e1ebf4;color:#5a7086}
    .v435-break-row b{color:#214763;font-size:15px;white-space:nowrap}
    .v435-full-detail-btn,.v435-back-summary-btn{width:100%;margin-top:12px;justify-content:center!important;padding:10px 14px!important;font-size:13px!important;font-weight:850!important}
    .v435-full-meta-grid{display:grid;grid-template-columns:minmax(0,.7fr) minmax(0,1.3fr);gap:9px;margin-bottom:10px}
    .v435-full-meta-grid>div{min-width:0;padding:11px 12px;border-radius:13px;background:#f4f8fc;border:1px solid #e0e9f2}
    .v435-full-meta-grid small{display:block;margin-bottom:4px;color:#71879a;font-size:11px;font-weight:800}
    .v435-full-meta-grid b{display:block;color:#29465f;line-height:1.45;overflow-wrap:anywhere}
    .v435-full-duty-box{background:#fff}
    .v435-full-duty-box p{margin:0;color:#3c5369;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere}
    @media(max-width:820px){
      #modal:has(.v435-position-summary-modal),#modal:has(.v435-position-full-modal){place-items:end center;padding:0!important}
      #modal:has(.v435-position-summary-modal)>.modal-card,#modal:has(.v435-position-full-modal)>.modal-card{width:100%!important;max-width:none!important;max-height:82dvh!important;border-radius:24px 24px 0 0!important;padding:22px 18px max(22px,env(safe-area-inset-bottom))!important}
      .v435-modal-heading h2{font-size:21px}
      .v435-main-duty-box,.v435-full-duty-box{padding:13px 14px}
      .v435-main-duty-box li{font-size:14px}
      .v435-full-meta-grid{grid-template-columns:1fr}
    }
    @media(max-width:390px){
      .v435-modal-heading h2{font-size:19px}
      .v435-main-duty-box h3,.v435-full-duty-box h3{font-size:15px}
      .v435-main-duty-box li,.v435-full-duty-box p{font-size:13px}
    }
  `;
  document.head.appendChild(style);

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',queue,{once:true});else queue();
  window.addEventListener('pageshow',queue);
  window.cnmiV435={version:VERSION,decorateDashboard,metadataFor,splitMainDuties,showSummary,showFull};
  console.info(`${VERSION} loaded`);
})();
