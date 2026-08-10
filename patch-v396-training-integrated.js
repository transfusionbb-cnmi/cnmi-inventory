/* CNMI Staff Planner V426
 * Training is integrated into the existing activity form.  There is no second
 * "add training activity" page and no new-staff form in this version.
 */
(function () {
  'use strict';
  if (window.__CNMI_V396_TRAINING_INTEGRATED__) return;
  window.__CNMI_V396_TRAINING_INTEGRATED__ = true;

  const S = () => window.state || state;
  const DB = () => window.sb || sb;
  const esc = v => typeof escapeHtml === 'function' ? escapeHtml(v == null ? '' : String(v)) : String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const idEq = (a,b) => String(a || '') === String(b || '');
  const staffOf = id => (S().staff || []).find(x => idEq(x.id,id)) || {};
  const staffName = id => { const x = staffOf(id); return x.nickname || x.full_name || x.email || '-'; };
  const dateKey = v => {
    const raw = String(v || '').trim();
    if (!raw) return '';
    let m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return `${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`;
    m = raw.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
    if (m) {
      let year = Number(m[3]);
      if (year > 2400) year -= 543;
      return `${year}-${String(m[2]).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`;
    }
    const d = new Date(raw);
    if (!Number.isFinite(d.getTime())) return raw.slice(0,10);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  };
  const dateLabel = v => v ? (typeof formatThaiDate === 'function' ? formatThaiDate(v) : v) : '-';
  const dateTimeLabel = v => v ? (typeof formatThaiDateTime === 'function' ? formatThaiDateTime(v) : v) : '-';
  const actor = () => typeof currentStaffId === 'function' ? currentStaffId() : S().profile?.id;
  const isManager = () => (typeof isAdmin === 'function' && isAdmin()) || S().profile?.staff_type === 'แพทย์' || ['doctor','physician'].includes(String(S().profile?.role || '').toLowerCase());
  const TABLE = 'activity_training_records_v396';

  function trainingRows() { return Array.isArray(S().trainingRecords) ? S().trainingRecords.filter(x => x.is_included !== false && x.form_type === 'existing') : []; }
  function activity(id) { return (S().activities || []).find(x => idEq(x.id,id)); }
  function rowItems() { return trainingRows().map(r => ({ record:r, activity:activity(r.activity_id) })).filter(x => x.activity); }
  function status(r) { return r.result_text || r.application_text || r.certificate_path ? 'กรอกข้อมูลแล้ว' : 'รอกรอกข้อมูล'; }
  function employment(id) { const x=staffOf(id); return x.employment_start_date || x.start_date || ''; }
  const ORGANIZER_MARKER_RE = /\[\[FM-CNHR-002-ORGANIZER:([^\]]*)\]\]\s*/i;
  const BATCH_MARKER_RE = /\[\[FM-CNHR-002-BATCH:([^\]]*)\]\]\s*/i;
  function decodeMarker(note,re) {
    const match=String(note||'').match(re);
    if(!match)return '';
    try{return decodeURIComponent(match[1]||'').trim();}catch(_){return String(match[1]||'').trim();}
  }
  function organizerFromNote(note) { return decodeMarker(note,ORGANIZER_MARKER_RE); }
  function batchFromNote(note) { return decodeMarker(note,BATCH_MARKER_RE); }
  function cleanActivityNote(note) { return String(note||'').replace(ORGANIZER_MARKER_RE,'').replace(BATCH_MARKER_RE,'').trim(); }
  function noteWithTrainingMeta(note,organizer,batch) {
    const clean=cleanActivityNote(note),parts=[];
    const organizerValue=String(organizer||'').trim(),batchValue=String(batch||'').trim();
    if(organizerValue)parts.push(`[[FM-CNHR-002-ORGANIZER:${encodeURIComponent(organizerValue)}]]`);
    if(batchValue)parts.push(`[[FM-CNHR-002-BATCH:${encodeURIComponent(batchValue)}]]`);
    return `${parts.join('')}${clean?(parts.length?'\n':'')+clean:''}`;
  }
  function activityOrganizerValue(a) { return String(a?.organizer||a?.organizer_name||a?.provider||organizerFromNote(a?.note)||'').trim(); }
  function activityBatchValue(a) { return String(a?.training_batch||a?.batch||a?.generation||a?.cohort||batchFromNote(a?.note)||'').trim(); }
  function isMissingOrganizerColumn(error) {
    const text=String(error?.message||error||'');
    return /PGRST204/i.test(text)||(/organizer/i.test(text)&&/(column|schema cache|does not exist)/i.test(text));
  }
  window.cnmiCleanActivityNote=cleanActivityNote;
  window.cnmiActivityOrganizer=activityOrganizerValue;
  window.cnmiActivityTrainingBatch=activityBatchValue;

  async function loadTraining() {
    if (!S().profile || !DB()) return;
    const res = await DB().from(TABLE).select('*').order('updated_at', {ascending:false});
    if (res.error) { S().trainingRecords=[]; S().trainingSchemaError=res.error.message || String(res.error); return; }
    S().trainingRecords=res.data || [];
    S().trainingSchemaError='';

    // V400 intentionally does not preload every activity. The training page,
    // however, must resolve every activity referenced by a training record;
    // otherwise rowItems() drops the record and date filters appear empty.
    const known = new Set((S().activities || []).map(x => String(x.id)));
    const missingIds = [...new Set(S().trainingRecords.map(x => x.activity_id).filter(Boolean).map(String))]
      .filter(id => !known.has(id));
    if (!missingIds.length) return;

    const fetched = [];
    for (let i=0; i<missingIds.length; i+=100) {
      const q = await DB().from('activity_events').select('*').in('id', missingIds.slice(i,i+100));
      if (q.error) { S().trainingActivityLoadError=q.error.message || String(q.error); break; }
      fetched.push(...(q.data || []));
    }
    if (fetched.length) {
      const merged = new Map((S().activities || []).map(x => [String(x.id), x]));
      fetched.forEach(x => merged.set(String(x.id), x));
      S().activities = [...merged.values()];
    }
  }
  const oldLoad = window.loadAllData || (typeof loadAllData === 'function' && loadAllData);
  if (oldLoad) {
    window.loadAllData = async function () { const r=await oldLoad.apply(this,arguments); await loadTraining(); return r; };
    try { (0,eval)('loadAllData=window.loadAllData'); } catch (_) {}
  }

  function participantChecks(selected) {
    const ids = new Set((selected || []).map(String));
    const rows = typeof orderedStaff === 'function' ? orderedStaff((S().staff||[]).filter(x=>x.is_active!==false)) : (S().staff||[]);
    return `<div class="v396-participants">${rows.map(p=>`<label class="v396-participant"><input type="checkbox" name="participant_ids" value="${esc(p.id)}" ${ids.has(String(p.id))?'checked':''}><span><b>${esc(p.nickname||p.full_name||'-')}</b><small>${esc(p.full_name||'')}</small></span></label>`).join('')}</div>`;
  }

  const oldActivities = window.renderActivitiesPage || renderActivitiesPage;
  function renderActivitiesV396() {
    const rows=S().activities||[];
    const editing=S().editingActivityId ? rows.find(x=>idEq(x.id,S().editingActivityId)) : null;
    const included = editing?.training_form_existing === true || editing?.include_fm_cnhr_002 === true;
    const table = typeof renderActivityTable === 'function' ? renderActivityTable(rows) : '';
    return `<div class="grid grid-2"><div class="card"><div class="section-title"><h3>${editing?'แก้ไขกิจกรรม':'เพิ่มกิจกรรมหน่วยงาน'}</h3>${editing?'<button class="ghost-btn" data-cancel-edit-activity>ยกเลิกแก้ไข</button>':''}</div>
      <form id="activityForm" class="form-grid">
        <label class="wide">รายละเอียดกิจกรรม <input name="title" value="${esc(editing?.title||'')}" placeholder="เช่น ประชุมทีม / อบรม / ออกหน่วย" required></label>
        <div class="wide v405-training-meta-grid">
          <label class="v396-training-check"><input type="checkbox" name="include_fm_cnhr_002" ${included?'checked':''}> <span>เก็บเป็นประวัติอบรม FM-CNHR-002 <small>ติ๊กเมื่อ ต้องการนำกิจกรรมนี้เข้าประวัติการอบรมของผู้เข้าร่วม</small></span></label>
          <label class="v405-training-field v405-organizer-field ${included?'v405-required':''}">หน่วยงานผู้จัด <span class="v405-required-mark">*</span><input name="organizer" value="${esc(activityOrganizerValue(editing))}" placeholder="เช่น สภากาชาดไทย / บริษัทผู้จัด / หน่วยงานภายใน" ${included?'required':''}><small class="hint">แสดงในคอลัมน์ “หน่วยงานผู้จัด”</small></label>
          <label class="v405-training-field v408-batch-field ${included?'v405-required':''}">รุ่น <span class="v405-required-mark">*</span><input name="training_batch" value="${esc(activityBatchValue(editing)||(included?'-':''))}" placeholder="เช่น รุ่นที่ 18 หรือ -" ${included?'required':''}><small class="hint">หากไม่มีรุ่น ให้ใส่เครื่องหมาย -</small></label>
        </div>
        <label>ประเภท <select name="event_type" required>${(typeof ACTIVITY_TYPES!=='undefined'?ACTIVITY_TYPES:['ประชุม','อบรม','ออกหน่วย','ตรวจมาตรฐาน','ซ้อม CODE','อื่นๆ']).map(t=>`<option ${editing?.event_type===t?'selected':''}>${t}</option>`).join('')}</select></label>
        <label>สถานที่ <input name="location" list="activityLocationList" value="${esc(editing?.location||'')}" required></label><datalist id="activityLocationList">${(typeof ACTIVITY_LOCATIONS!=='undefined'?ACTIVITY_LOCATIONS:[]).map(x=>`<option value="${esc(x)}"></option>`).join('')}</datalist>
        <label>วันที่เริ่ม <input name="start_date" type="date" value="${esc(editing?.start_date||todayStr())}" required></label><label>วันที่สิ้นสุด <input name="end_date" type="date" value="${esc(editing?.end_date||todayStr())}" required></label>
        <label>เวลาเริ่ม <input name="start_time" type="time" value="${esc(editing?.start_time||'')}" required></label><label>เวลาสิ้นสุด <input name="end_time" type="time" value="${esc(editing?.end_time||'')}" required></label>
        <label>ผู้รับผิดชอบ <select name="owner_id" required><option value="">เลือกผู้รับผิดชอบ</option>${staffOptions(editing?.owner_id||actor())}</select></label><label>เอกสารแนบ <input name="file" type="file"></label>
        <div class="wide"><div class="field-label">ผู้เข้าร่วม</div>${participantChecks(asArray(editing?.participant_ids))}</div>
        <label class="wide">หมายเหตุเพิ่มเติม <textarea name="note">${esc(cleanActivityNote(editing?.note||''))}</textarea></label><button class="primary-btn wide" type="submit">${editing?'บันทึกการแก้ไข':'บันทึกกิจกรรม'}</button>
      </form></div><div class="card"><div class="section-title"><h3>กิจกรรมทั้งหมด</h3></div>${table}</div></div>`;
  }
  window.renderActivitiesPage=renderActivitiesV396; try{(0,eval)('renderActivitiesPage=window.renderActivitiesPage');}catch(_){ }

  async function saveActivityV396(form) {
    const fd=new FormData(form), participants=[...form.querySelectorAll('[name="participant_ids"]:checked')].map(x=>x.value);
    const include=form.querySelector('[name="include_fm_cnhr_002"]')?.checked===true;
    const organizer=String(fd.get('organizer')||'').trim(),trainingBatch=String(fd.get('training_batch')||'').trim(),cleanNote=cleanActivityNote(fd.get('note'));
    const storedNote=include?noteWithTrainingMeta(cleanNote,'',trainingBatch):cleanNote;
    const row={title:String(fd.get('title')||'').trim(),event_type:fd.get('event_type'),start_date:fd.get('start_date'),end_date:fd.get('end_date'),start_time:fd.get('start_time')||null,end_time:fd.get('end_time')||null,location:String(fd.get('location')||'').trim(),organizer:include?organizer:null,note:storedNote,owner_id:fd.get('owner_id')||actor(),participant_ids:participants,include_fm_cnhr_002:include,training_form_existing:include,updated_by:actor()};
    const required=[['title','รายละเอียดกิจกรรม'],['event_type','ประเภท'],['location','สถานที่'],['start_date','วันที่เริ่ม'],['end_date','วันที่สิ้นสุด'],['start_time','เวลาเริ่ม'],['end_time','เวลาสิ้นสุด'],['owner_id','ผู้รับผิดชอบ']].filter(([k])=>!row[k]).map(([,v])=>v);
    if(include&&!organizer)required.push('หน่วยงานผู้จัด');
    if(include&&!trainingBatch)required.push('รุ่น (หากไม่มีให้ใส่ -)');
    if(row.event_type==='ออกหน่วย'&&!participants.length) required.push('ผู้เข้าร่วมสำหรับออกหน่วย');
    if(required.length)return showToast('กรุณากรอก/เลือกให้ครบ: '+required.join(', '));
    if(row.end_date<row.start_date)return showToast('วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่ม');
    if(row.start_date===row.end_date&&row.end_time<=row.start_time)return showToast('เวลาสิ้นสุดต้องมากกว่าเวลาเริ่ม');
    try{
      const file=fd.get('file'); if(file?.size&&typeof uploadFile==='function') row.attachment_path=await uploadFile(file,'activities');
      const id=S().editingActivityId;
      const persist=payload=>id?DB().from('activity_events').update(payload).eq('id',id).select('*').single():DB().from('activity_events').insert({...payload,created_by:actor()}).select('*').single();
      let res=await persist(row);
      if(res.error&&isMissingOrganizerColumn(res.error)){
        const compatibleRow={...row,note:noteWithTrainingMeta(cleanNote,include?organizer:'',include?trainingBatch:'')};
        delete compatibleRow.organizer;
        res=await persist(compatibleRow);
      }
      if(res.error)throw res.error;
      const activityId=res.data?.id||id;
      const old=await DB().from(TABLE).select('*').eq('activity_id',activityId);
      if(old.error&&!/does not exist|relation/i.test(old.error.message||''))throw old.error;
      const oldRows=old.data||[];
      if(include){
        const desired=participants.map(staff_id=>{const prev=oldRows.find(x=>idEq(x.staff_id,staff_id)&&x.form_type==='existing');return {...(prev?.id?{id:prev.id}:{}),activity_id:activityId,staff_id,form_type:'existing',is_included:true,employment_start_date_snapshot:prev?.employment_start_date_snapshot||employment(staff_id)||null,updated_by:actor()};});
        if(desired.length){const up=await DB().from(TABLE).upsert(desired,{onConflict:'activity_id,staff_id,form_type'});if(up.error)throw up.error;}
        for(const oldRow of oldRows.filter(x=>x.form_type==='existing'&&!participants.map(String).includes(String(x.staff_id)))) await DB().from(TABLE).update({is_included:false,updated_by:actor()}).eq('id',oldRow.id);
      }else for(const oldRow of oldRows.filter(x=>x.form_type==='existing')) await DB().from(TABLE).update({is_included:false,updated_by:actor()}).eq('id',oldRow.id);
      S().editingActivityId=null; await loadAllData(); renderPage(); showToast(include?'บันทึกกิจกรรมและนำเข้า FM-CNHR-002 แล้ว':'บันทึกกิจกรรมแล้ว');
    }catch(e){showToast(e?.message||String(e));}
  }

  function trainingFormNotice(){return S().trainingSchemaError?`<div class="notice warning">ระบบอบรมยังไม่พร้อมใช้งาน กรุณารัน SQL <code>supabase_v396_training_integrated.sql</code> ก่อน</div>`:'';}
  function recordForm(item,index){
    const r=item.record,a=item.activity,currentStatus=status(r),pending=currentStatus==='รอกรอกข้อมูล';
    const dateText=`${dateLabel(a.start_date)}${dateKey(a.end_date)!==dateKey(a.start_date)?' – '+dateLabel(a.end_date):''}`;
    return `<article class="card v396-record v416-training-card ${pending?'v416-training-card-pending':'v416-training-card-complete'}">
      <div class="v416-record-head">
        <div class="v416-record-heading"><span class="v416-record-number">รายการที่ ${index+1}</span><h3>${esc(a.title)}</h3></div>
        <div class="v416-record-status">${badge(currentStatus,pending?'orange':'green')}</div>
      </div>
      <div class="v416-record-meta"><span><b>วันที่</b> ${esc(dateText)}</span><span><b>สถานที่</b> ${esc(a.location||'-')}</span><span><b>รุ่น</b> ${esc(activityBatchValue(a)||'-')}</span><span><b>หน่วยงานผู้จัด</b> ${esc(activityOrganizerValue(a)||a.location||'-')}</span></div>
      <form class="v416-record-form" data-v396-record="${esc(r.id)}">
        <div class="v416-record-form-grid">
          <label class="v416-answer-field"><span class="v416-field-title">ผล/สิ่งที่ได้รับ</span><small>สรุปความรู้ ประเด็นสำคัญ หรือสิ่งที่ได้จากกิจกรรม</small><textarea name="result_text" rows="5" placeholder="เช่น ได้ทบทวนหลักการ... / ได้เรียนรู้แนวทาง...">${esc(r.result_text||'')}</textarea></label>
          <label class="v416-answer-field"><span class="v416-field-title">การนำความรู้ไปใช้</span><small>ระบุว่าจะนำไปปรับใช้กับงานหรือพัฒนาหน่วยงานอย่างไร</small><textarea name="application_text" rows="5" placeholder="เช่น นำไปปรับขั้นตอน... / ถ่ายทอดให้ทีม...">${esc(r.application_text||'')}</textarea></label>
        </div>
        <div class="v416-record-bottom">
          <label class="v416-certificate-field"><span class="v416-field-title">Certificate <small>(ไม่บังคับ)</small></span><input type="file" name="certificate" accept=".pdf,image/*">${r.certificate_name?`<small class="v416-file-current">ไฟล์ปัจจุบัน: ${esc(r.certificate_name)}</small>`:'<small>รองรับ PDF หรือรูปภาพ</small>'}</label>
          <div class="v416-save-area"><small>${pending?'กรอกอย่างน้อย 1 ช่อง แล้วกดบันทึก':'แก้ไขข้อมูลแล้วกดบันทึกได้ทันที'}</small><button class="primary-btn" type="submit">${pending?'บันทึกผลการอบรม':'บันทึกการแก้ไข'}</button></div>
        </div>
      </form>
    </article>`;
  }
  function myTrainingStatus(){return Object.prototype.hasOwnProperty.call(S(),'v402MyStatus')?String(S().v402MyStatus||''):'รอกรอกข้อมูล';}
  function currentGregorianYear(){return new Date().getFullYear();}
  function selectedTrainingYear(){
    const direct=Number(S().v407TrainingYear);
    return Number.isInteger(direct)&&direct>=2000&&direct<=2200?direct:0;
  }
  function applyTrainingYearRange(year){
    const y=Number(year),s=S();
    if(!Number.isInteger(y)||y<2000||y>2200){s.v407TrainingYear='';s.v396MyFrom='';s.v396MyTo='';return {year:0,from:'',to:''};}
    s.v407TrainingYear=String(y);s.v396MyFrom=`${y}-01-01`;s.v396MyTo=`${y}-12-31`;
    return {year:y,from:s.v396MyFrom,to:s.v396MyTo};
  }
  function trainingYearOptions(){
    const years=new Set([currentGregorianYear()-2,currentGregorianYear()-1,currentGregorianYear(),currentGregorianYear()+1]);
    rowItems().forEach(x=>{const y=Number(dateKey(x.activity?.start_date).slice(0,4));if(Number.isInteger(y)&&y>=2000&&y<=2200)years.add(y);});
    return [...years].sort((a,b)=>b-a);
  }
  function isMyTrainingFilterReady(){return ['รอกรอกข้อมูล','กรอกข้อมูลแล้ว','all'].includes(myTrainingStatus())&&selectedTrainingYear()>0;}
  function myTrainingAnnualRows(){
    if(!isMyTrainingFilterReady())return [];
    const range=applyTrainingYearRange(selectedTrainingYear());
    return rowItems().filter(x=>{if(!idEq(x.record.staff_id,actor()))return false;const start=dateKey(x.activity.start_date),end=dateKey(x.activity.end_date)||start;return end>=range.from&&start<=range.to;}).sort((a,b)=>dateKey(a.activity.start_date).localeCompare(dateKey(b.activity.start_date)));
  }
  function myTrainingFilters(){
    const selected=myTrainingStatus(),year=selectedTrainingYear(),ready=isMyTrainingFilterReady(),annualRows=ready?myTrainingAnnualRows():[],canExport=ready&&annualRows.length>0;
    return `<div class="toolbar compact-filter v396-filters v402-my-training-filters v407-year-filter v416-filter-gate v417-my-training-filters">
      <label><span class="v417-control-label">สถานะข้อมูล</span><select id="v402MyStatus"><option value="รอกรอกข้อมูล" ${selected==='รอกรอกข้อมูล'?'selected':''}>รอกรอกข้อมูล</option><option value="กรอกข้อมูลแล้ว" ${selected==='กรอกข้อมูลแล้ว'?'selected':''}>กรอกข้อมูลแล้ว</option><option value="all" ${selected==='all'?'selected':''}>ทั้งหมด</option></select></label>
      <label><span class="v417-control-label">ปีแบบฟอร์ม</span><select id="v407TrainingYear"><option value="" ${!year?'selected':''} disabled>เลือกปีแบบฟอร์ม</option>${trainingYearOptions().map(y=>`<option value="${y}" ${y===year?'selected':''}>พ.ศ. ${y+543}</option>`).join('')}</select></label>
      <div class="v402-export-wrap"><span class="v417-control-label">ส่งออกเอกสาร</span><button class="primary-btn" type="button" data-v402-my-export ${canExport?'':'disabled'}>Export PDF ชุดอบรมประจำปี</button></div>
    </div>`;
  }
  function myTrainingRows(){
    if(!isMyTrainingFilterReady())return [];
    const selected=myTrainingStatus(),rows=myTrainingAnnualRows();
    return selected==='all'?rows:rows.filter(x=>status(x.record)===selected);
  }
  const MY_TRAINING_PAGE_SIZE=1;
  function myTrainingPage(){const page=Number(S().v417MyTrainingPage);return Number.isInteger(page)&&page>0?page:1;}
  function myTrainingPagination(totalRows,currentPage,totalPages){
    if(totalPages<=1)return '';
    return `<nav class="v417-training-pagination" aria-label="เปลี่ยนหน้ารายการอบรม"><button class="ghost-btn v417-page-btn" type="button" data-v417-my-page="${currentPage-1}" ${currentPage<=1?'disabled':''}>ก่อนหน้า</button><span>หน้า ${currentPage} / ${totalPages}</span><button class="ghost-btn v417-page-btn" type="button" data-v417-my-page="${currentPage+1}" ${currentPage>=totalPages?'disabled':''}>หน้าถัดไป</button></nav>`;
  }
  function trainingSelectionPrompt(text){return `<div class="v416-selection-prompt"><div class="v416-selection-icon">⌄</div><div><b>${esc(text)}</b><small>ระบบจะยังไม่เปิดรายการทั้งหมด เพื่อให้หน้าจออ่านง่ายและโหลดเฉพาะข้อมูลที่ต้องการ</small></div></div>`;}
  function renderMyTraining(){
    if(!S().profile)return noPermission();
    const ready=isMyTrainingFilterReady(),allRows=ready?myTrainingRows():[],year=selectedTrainingYear(),totalPages=Math.max(1,Math.ceil(allRows.length/MY_TRAINING_PAGE_SIZE)),currentPage=Math.min(myTrainingPage(),totalPages),start=(currentPage-1)*MY_TRAINING_PAGE_SIZE,rows=allRows.slice(start,start+MY_TRAINING_PAGE_SIZE);
    S().v417MyTrainingPage=currentPage;
    return `<div class="card v416-training-page"><div class="section-title"><div><h3>รายการอบรมของฉัน</h3><p class="hint">สถานะเริ่มต้นเป็น “รอกรอกข้อมูล” เลือกปีแบบฟอร์มเพื่อแสดงรายการ</p></div></div>${trainingFormNotice()}${myTrainingFilters()}${!ready?trainingSelectionPrompt('เลือก “ปีแบบฟอร์ม” ก่อน'):allRows.length?`<div class="v396-record-list">${rows.map((item,index)=>recordForm(item,start+index)).join('')}</div>${myTrainingPagination(allRows.length,currentPage,totalPages)}`:empty(`ไม่พบรายการอบรมในปี ${year+543} ตามตัวกรอง`)}</div>`;
  }
  function ensureAdminDateRange(){
    const s=S(),year=currentGregorianYear();
    if(!Object.prototype.hasOwnProperty.call(s,'v396From'))s.v396From=`${year}-01-01`;
    if(!Object.prototype.hasOwnProperty.call(s,'v396To'))s.v396To=`${year}-12-31`;
  }
  function adminFiltersReady(){const s=S();ensureAdminDateRange();return Boolean(s.v396From&&s.v396To&&s.v396Staff&&s.v396Status);}
  function filters(){
    const s=S();ensureAdminDateRange();
    return `<div class="toolbar compact-filter v396-filters v416-admin-training-filters">
      <label>จากวันที่ <input type="date" id="v396From" value="${esc(s.v396From||'')}"></label>
      <label>ถึงวันที่ <input type="date" id="v396To" value="${esc(s.v396To||'')}"></label>
      <label>บุคลากร <select id="v396Staff"><option value="" ${!s.v396Staff?'selected':''} disabled>เลือกบุคลากร</option><option value="all" ${s.v396Staff==='all'?'selected':''}>ทุกคน</option>${(S().staff||[]).filter(x=>x.is_active!==false).map(x=>`<option value="${esc(x.id)}" ${idEq(s.v396Staff,x.id)?'selected':''}>${esc(staffName(x.id))}</option>`).join('')}</select></label>
      <label>สถานะข้อมูล <select id="v396Status"><option value="" ${!s.v396Status?'selected':''} disabled>เลือกสถานะข้อมูล</option><option value="all" ${s.v396Status==='all'?'selected':''}>ทุกสถานะ</option><option value="กรอกข้อมูลแล้ว" ${s.v396Status==='กรอกข้อมูลแล้ว'?'selected':''}>กรอกข้อมูลแล้ว</option><option value="รอกรอกข้อมูล" ${s.v396Status==='รอกรอกข้อมูล'?'selected':''}>รอกรอกข้อมูล</option></select></label>
    </div>`;
  }
  function filtered(){
    if(!adminFiltersReady())return [];
    const s=S();
    return rowItems().filter(x=>{const start=dateKey(x.activity.start_date),end=dateKey(x.activity.end_date)||start;return end>=s.v396From&&start<=s.v396To&&(s.v396Staff==='all'||idEq(x.record.staff_id,s.v396Staff))&&(s.v396Status==='all'||status(x.record)===s.v396Status);}).sort((a,b)=>dateKey(b.activity.start_date).localeCompare(dateKey(a.activity.start_date)));
  }
  function renderTrainingAdmin(){
    if(!isManager())return noPermission();
    const ready=adminFiltersReady(),rows=ready?filtered():[],s=S(),canExport=ready&&(rows.length>0||s.v396Status==='all'),exportLabel=s.v396Staff==='all'?'Export PDF ทุกคน':'Export PDF บุคลากรที่เลือก';
    return `<div class="card"><div class="section-title"><div><h3>ตรวจสอบอบรมของเจ้าหน้าที่</h3><p class="hint">เลือกบุคลากรและสถานะข้อมูลก่อน ระบบจึงจะแสดงตารางและเปิดปุ่ม Export</p></div><button class="ghost-btn" type="button" data-v396-admin-export ${canExport?'':'disabled'}>${exportLabel}</button></div>${trainingFormNotice()}${filters()}${!ready?trainingSelectionPrompt('เลือก “บุคลากร” และ “สถานะข้อมูล” ก่อน'):rows.length?`<div class="table-wrap"><table><thead><tr><th>บุคลากร</th><th>กิจกรรม</th><th>วันที่/สถานที่</th><th>แบบฟอร์ม</th><th>สถานะ</th><th>อัปเดตล่าสุด</th></tr></thead><tbody>${rows.map(x=>`<tr><td>${esc(staffName(x.record.staff_id))}</td><td>${esc(x.activity.title)}</td><td>${dateLabel(x.activity.start_date)}<br>${esc(x.activity.location||'-')}</td><td>FM-CNHR-002</td><td>${badge(status(x.record),status(x.record)==='กรอกข้อมูลแล้ว'?'green':'orange')}</td><td>${dateTimeLabel(x.record.updated_at||x.record.created_at)}</td></tr>`).join('')}</tbody></table></div>`:empty('ไม่พบข้อมูลตามตัวกรอง')}</div>`;
  }

  function dayDiff(start,end){const a=new Date(`${dateKey(start)}T00:00:00`),b=new Date(`${dateKey(end||start)}T00:00:00`);return Number.isFinite(a.getTime())&&Number.isFinite(b.getTime())?Math.max(1,Math.round((b-a)/86400000)+1):1;}
  function durationLabel(a){const start=dateKey(a?.start_date),end=dateKey(a?.end_date)||start;if(start===end){const sh=String(a?.start_time||''),eh=String(a?.end_time||'');if(/^\d{2}:\d{2}/.test(sh)&&/^\d{2}:\d{2}/.test(eh)){const [h1,m1]=sh.split(':').map(Number),[h2,m2]=eh.split(':').map(Number),mins=(h2*60+m2)-(h1*60+m1);if(mins>0)return mins<=300?'0.5 วัน':'1 วัน';}if(a?.duration_label)return String(a.duration_label);return '1 วัน';}return `${dayDiff(start,end)} วัน`;}
  function thaiYear(date){const d=new Date(`${dateKey(date)}T00:00:00`);return Number.isFinite(d.getTime())?d.getFullYear()+543:'';}
  function thaiDateLong(date){
    const key=dateKey(date);if(!key)return '-';
    const d=new Date(`${key}T00:00:00`);if(!Number.isFinite(d.getTime()))return dateLabel(date);
    try{return new Intl.DateTimeFormat('th-TH',{day:'numeric',month:'long',year:'numeric'}).format(d);}catch(_){return dateLabel(date);}
  }
  function annualFormTitle(year){return `แบบบันทึกการอบรมประจำปี ${Number(year)+543}`;}
  function organizerText(a){return activityOrganizerValue(a)||a?.location||'-';}
  function chunkRows(items,size){const out=[];for(let i=0;i<items.length;i+=size)out.push(items.slice(i,i+size));return out.length?out:[[]];}
  function normalizedPersonText(value){return String(value||'').replace(/\s+/g,'').replace(/^(นาย|นางสาว|นาง|พญ\.|นพ\.|แพทย์หญิง|แพทย์ชาย)/,'');}
  function isParichatProfile(profile){
    const name=normalizedPersonText(profile?.full_name||'');
    const code=String(profile?.employee_code||profile?.personnel_code||'').trim();
    return name.includes('ปาริฉัตรอินทร์เกลี้ยง')||code==='020305';
  }
  function isPhysicianTrainingProfile(profile){
    const type=String(profile?.staff_type||profile?.position||profile?.job_title||'').trim();
    const role=String(profile?.role||profile?.app_role||'').trim();
    return /แพทย์|physician|doctor/i.test(`${type} ${role}`);
  }
  function headDisplayName(head){
    const raw=String(head?.full_name||'ปาริฉัตร อินทร์เกลี้ยง').trim();
    return /^(นาย|นางสาว|นาง|พญ\.|นพ\.|แพทย์หญิง|แพทย์ชาย)/.test(raw)?raw:`นางสาว ${raw}`;
  }
  function annualFormStyles(){return `@page{size:A4 portrait;margin:5mm 5mm 6mm}*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff}body{font-family:"TH Sarabun New",Sarabun,Tahoma,sans-serif;color:#000;font-size:16pt;font-weight:400;line-height:1}.fm-page{width:200mm;height:283.5mm;display:grid;grid-template-rows:auto auto minmax(0,1fr) auto auto;overflow:hidden;padding-bottom:1mm;break-after:page;page-break-after:always;background:#fff}.fm-page:last-child{break-after:auto;page-break-after:auto}table{width:100%;border-collapse:collapse;border-spacing:0}.fm-header td{border:0.5pt solid #111;padding:1.05mm 2mm;font-size:16pt;font-weight:700;line-height:.98}.header-label{display:inline-block;min-width:43mm;font-weight:700}.logo-cell{width:27mm;text-align:center;padding:.8mm!important}.fm-logo{display:block;width:23mm;height:23mm;object-fit:contain;margin:auto}.fm-person{margin-top:1mm;table-layout:fixed;border:0.5pt solid #111}.fm-person td{border:0;width:50%;padding:1.45mm 3mm;font-size:16pt;font-weight:700;line-height:.98}.fm-field{display:grid;grid-template-columns:29mm 3mm minmax(0,1fr);align-items:end;gap:1mm}.fm-field b{white-space:nowrap;font-weight:700}.fm-fill-line{display:block;text-align:center;border-bottom:0.5pt solid #111;min-height:5.8mm;line-height:5.8mm;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:700}.fm-training{margin-top:2mm;table-layout:fixed;height:100%;border:0.5pt solid #111}.fm-page.fm-natural-measure .fm-training{height:auto!important;align-self:start!important}.fm-page.fm-natural-measure .fm-training tr.blank{display:none!important}.fm-training thead{display:table-header-group}.fm-training tr{break-inside:avoid;page-break-inside:avoid}.fm-training th,.fm-training td{border:0.5pt solid #111}.fm-training th{padding:.95mm .55mm;font-size:14.5pt;font-weight:700;line-height:1;text-align:center;vertical-align:middle}.fm-training td{height:7.45mm;padding:.65mm 1.15mm;vertical-align:top;font-size:14pt;font-weight:400;line-height:1.02}.fm-training th:nth-child(1){width:4%}.fm-training th:nth-child(2){width:35%}.fm-training th:nth-child(3){width:5%}.fm-training th:nth-child(4){width:24%}.fm-training th:nth-child(5){width:11%}.fm-training th:nth-child(6){width:11%}.fm-training th:nth-child(7){width:10%}.center{text-align:center}.blank td{height:7.45mm;padding:0}.signatures{border:0.5pt solid #111;border-top:0;display:grid;grid-template-columns:1fr 1fr;gap:12mm;padding:5.2mm 10mm 3.6mm;text-align:center;font-size:16pt;font-weight:400;line-height:1.12;min-height:34mm}.signatures.single-signature{grid-template-columns:1fr;gap:0;padding-left:45mm;padding-right:45mm}.signatures.single-signature .signature-box{justify-self:center;width:100%;max-width:90mm}.signature-box{align-self:center}.signature-dots{display:inline-block;width:55mm;border-bottom:0.5pt dotted #111;vertical-align:baseline;transform:none}.signature-name{display:inline-block;min-height:5.5mm;margin-top:1.8mm}.manual-supervisor-name{white-space:nowrap}.signature-name-dots{display:inline-block;width:46mm;min-height:4.7mm;border-bottom:0.5pt dotted #111;vertical-align:baseline}.fm-footer{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;min-height:4mm;padding:.55mm .5mm 0;font-size:8.5pt;font-weight:400;line-height:1}.page-number{justify-self:center;white-space:nowrap}.form-code{justify-self:end;white-space:nowrap}.fm-vector-line-capture .fm-header td,.fm-vector-line-capture .fm-person,.fm-vector-line-capture .fm-training,.fm-vector-line-capture .fm-training th,.fm-vector-line-capture .fm-training td{border-color:transparent!important}.fm-vector-line-capture .fm-fill-line{border-bottom-color:transparent!important}@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}`; }
  function annualFormDocument(items,options={}){
    const year=Number(options.year)||selectedTrainingYear(),staffId=options.staffId||items?.[0]?.record?.staff_id||actor();
    if(!year||!staffId)return null;
    const profile=staffOf(staffId),personName=profile.full_name||profile.nickname||'-',employeeCode=profile.employee_code||profile.personnel_code||'-',position=profile.position||profile.staff_type||'-',startWork=employment(staffId);
    const head=(S().staff||[]).find(x=>normalizedPersonText(x.full_name).includes('ปาริฉัตรอินทร์เกลี้ยง'))||{};
    const physicianProfile=isPhysicianTrainingProfile(profile);
    const supervisorName=(isParichatProfile(profile)||physicianProfile)?'':headDisplayName(head);
    const logoUrl=new URL('fm-cnhr-002-logo.png',window.location.href).href,pages=chunkRows(items||[],20),title=annualFormTitle(year);
    const sections=pages.map((page,pageIndex)=>{
      const offset=pageIndex*20,blank=Math.max(0,20-page.length);
      const rows=page.map((x,i)=>`<tr><td class="center">${offset+i+1}</td><td>${esc(x.activity.title||'-')}</td><td class="center">${esc(activityBatchValue(x.activity)||'-')}</td><td>${esc(organizerText(x.activity))}</td><td class="center">${esc(dateLabel(x.activity.start_date))}</td><td class="center">${esc(dateLabel(x.activity.end_date||x.activity.start_date))}</td><td class="center">${esc(durationLabel(x.activity))}</td></tr>`).join('')+Array.from({length:blank},()=>'<tr class="blank"><td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>').join('');
      const supervisorLine=supervisorName?`(${esc(supervisorName)})`:'(<span class="signature-name-dots"></span>)';
      const signatureHtml=physicianProfile
        ? `<div class="signatures single-signature"><div class="signature-box">ลงชื่อ <span class="signature-dots"></span><br><span class="signature-name">(${esc(personName)})</span><br>บุคลากรผู้รับการฝึกอบรม</div></div>`
        : `<div class="signatures"><div class="signature-box">ลงชื่อ <span class="signature-dots"></span><br><span class="signature-name">(${esc(personName)})</span><br>บุคลากรผู้รับการฝึกอบรม</div><div class="signature-box">ลงชื่อ <span class="signature-dots"></span><br><span class="signature-name ${supervisorName?'':'manual-supervisor-name'}">${supervisorLine}</span><br>หัวหน้าหน่วย/หัวหน้างาน</div></div>`;
      return `<section class="fm-page"><table class="fm-header"><tr><td class="logo-cell" rowspan="3"><img class="fm-logo" src="${esc(logoUrl)}" alt="ตรามหาวิทยาลัยมหิดล"></td><td><span class="header-label">ชื่อแบบฟอร์ม :</span><b>${esc(title)}</b></td></tr><tr><td><span class="header-label">ฝ่าย/งาน/หน่วย :</span><b>งานพยาธิ นิติเวช และบริการโลหิต</b></td></tr><tr><td>โรงพยาบาลรามาธิบดีจักรีนฤบดินทร์ คณะแพทยศาสตร์โรงพยาบาลรามาธิบดี มหาวิทยาลัยมหิดล</td></tr></table><table class="fm-person"><tr><td><div class="fm-field"><b>ชื่อ สกุล</b><b>:</b><span class="fm-fill-line">${esc(personName)}</span></div></td><td><div class="fm-field"><b>รหัสบุคคล</b><b>:</b><span class="fm-fill-line">${esc(employeeCode)}</span></div></td></tr><tr><td><div class="fm-field"><b>ตำแหน่ง</b><b>:</b><span class="fm-fill-line">${esc(position)}</span></div></td><td><div class="fm-field"><b>วันเริ่มงาน</b><b>:</b><span class="fm-fill-line">${esc(thaiDateLong(startWork))}</span></div></td></tr></table><table class="fm-training"><thead><tr><th>ที่</th><th>หลักสูตร/เรื่อง</th><th>รุ่น</th><th>หน่วยงานผู้จัด</th><th>วันที่เริ่มต้น</th><th>วันที่สิ้นสุด</th><th>ระยะเวลา</th></tr></thead><tbody>${rows}</tbody></table>${signatureHtml}<div class="fm-footer"><span></span><span class="page-number">หน้าที่ ${pageIndex+1} ของ ${pages.length} หน้า</span><span class="form-code">FM-CNHR-002 Rev.00&nbsp;&nbsp; วันบังคับใช้ 1 ตุลาคม 2561</span></div></section>`;
    }).join('');
    return {year,staffId,personName,sections,styles:annualFormStyles(),pageCount:pages.length};
  }
  function wait(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
  async function waitForFrameAssets(doc){
    const imageTasks=[...doc.images].map(img=>img.complete?Promise.resolve():new Promise(resolve=>{img.onload=img.onerror=()=>resolve();}));
    await Promise.race([Promise.all(imageTasks),wait(3500)]);
    if(doc.fonts?.ready)await Promise.race([doc.fonts.ready,wait(2500)]);
    await wait(120);
  }
  function annualActualRows(page){return [...(page?.querySelectorAll('.fm-training tbody tr:not(.blank)')||[])];}
  function annualBlankRow(doc){
    const tr=doc.createElement('tr');tr.className='blank';
    tr.innerHTML='<td></td><td></td><td></td><td></td><td></td><td></td><td></td>';
    return tr;
  }
  function normalizeAnnualPageRows(page){
    const tbody=page?.querySelector('.fm-training tbody');if(!tbody)return;
    tbody.querySelectorAll('tr.blank').forEach(row=>row.remove());
    const actual=annualActualRows(page),requestedRaw=Number(page.dataset.fmSlotTarget ?? 20),requested=Number.isFinite(requestedRaw)?Math.max(0,Math.min(20,Math.round(requestedRaw))):20,slotTarget=Math.max(actual.length,requested);
    page.dataset.fmSlotTarget=String(requested);
    for(let i=actual.length;i<slotTarget;i++)tbody.appendChild(annualBlankRow(page.ownerDocument));
  }
  function annualNaturalMetrics(page){
    const actual=annualActualRows(page),table=page?.querySelector('.fm-training'),thead=table?.querySelector('thead'),signatures=page?.querySelector('.signatures');
    if(!table||!thead||!signatures)return {actual,capacity:0,contentHeight:0,blankMin:28.2,overflow:false};
    page.classList.add('fm-natural-measure');
    let metrics;
    try{
      const tableRect=table.getBoundingClientRect(),signatureRect=signatures.getBoundingClientRect();
      const capacity=Math.max(0,signatureRect.top-tableRect.top);
      const headHeight=thead.getBoundingClientRect().height;
      const rowHeights=actual.map(row=>row.getBoundingClientRect().height);
      const contentHeight=headHeight+rowHeights.reduce((sum,h)=>sum+h,0);
      const blankMin=7.45*96/25.4;
      metrics={actual,capacity,contentHeight,blankMin,rowHeights,overflow:actual.length>20||contentHeight>capacity+1.5};
    }finally{page.classList.remove('fm-natural-measure');}
    return metrics;
  }
  function annualBestSlotTarget(page){
    const m=annualNaturalMetrics(page),actualCount=m.actual.length;
    // V426: blank rows are decorative only. Add them only when the remaining
    // table area can really hold them, so a tall course row can never push
    // into the reserved signature area.
    if(!m.capacity)return actualCount;
    const free=Math.max(0,m.capacity-m.contentHeight);
    const blanks=Math.max(0,Math.min(20-actualCount,Math.floor((free+0.5)/Math.max(1,m.blankMin))));
    return Math.max(actualCount,Math.min(20,actualCount+blanks));
  }
  function createAnnualContinuationPage(sourcePage){
    const page=sourcePage.cloneNode(true),tbody=page.querySelector('.fm-training tbody');
    if(tbody)tbody.innerHTML='';
    page.dataset.fmSlotTarget='0';
    return page;
  }
  function refreshAnnualPageLabels(doc){
    const pages=[...doc.querySelectorAll('.fm-page')];let rowNo=1;
    pages.forEach((page,index)=>{
      annualActualRows(page).forEach(row=>{const first=row.querySelector('td');if(first)first.textContent=String(rowNo++);});
      const number=page.querySelector('.page-number');if(number)number.textContent=`หน้าที่ ${index+1} ของ ${pages.length} หน้า`;
    });
    return pages.length;
  }
  async function rebalanceAnnualTrainingPages(doc){
    let guard=0;
    // Measure only the natural height of real training rows. The visual blank
    // rows are added after the page split is stable; otherwise a 100%-height
    // table makes each real row look artificially tall and causes 1 item/page.
    [...doc.querySelectorAll('.fm-page')].forEach(page=>{page.dataset.fmSlotTarget=String(annualActualRows(page).length);normalizeAnnualPageRows(page);});
    while(guard++<120){
      const pages=[...doc.querySelectorAll('.fm-page')];let changed=false;
      for(let i=0;i<pages.length;i++){
        const page=pages[i],metrics=annualNaturalMetrics(page),actual=metrics.actual;
        if(!metrics.overflow)continue;
        // V426: the signature block is a hard reserved area. If the natural
        // height of the real rows exceeds the table area, move the last row
        // to the next page regardless of row count. This prevents long titles
        // or organizer names from growing downward over the signature fields.
        if(actual.length>1){
          const moving=actual[actual.length-1];
          let next=pages[i+1];
          if(!next){next=createAnnualContinuationPage(page);page.after(next);}
          const nextBody=next.querySelector('.fm-training tbody');
          nextBody?.querySelectorAll('tr.blank').forEach(row=>row.remove());
          if(nextBody)nextBody.insertBefore(moving,nextBody.firstChild);
          page.dataset.fmSlotTarget=String(annualActualRows(page).length);
          next.dataset.fmSlotTarget=String(annualActualRows(next).length);
          normalizeAnnualPageRows(page);normalizeAnnualPageRows(next);
          changed=true;break;
        }
      }
      if(!changed)break;
      await wait(12);
    }
    [...doc.querySelectorAll('.fm-page')].forEach(page=>{
      page.dataset.fmSlotTarget=String(annualBestSlotTarget(page));
      normalizeAnnualPageRows(page);
    });
    const count=refreshAnnualPageLabels(doc);
    await wait(60);
    return count;
  }
  async function createAnnualFrame(bundle){
    const frame=document.createElement('iframe');
    frame.setAttribute('aria-hidden','true');
    frame.style.cssText='position:fixed;left:-10000px;top:0;width:210mm;height:297mm;border:0;opacity:0;pointer-events:none;background:#fff;';
    document.body.appendChild(frame);
    const doc=frame.contentDocument;
    doc.open();
    doc.write(`<html><head><meta charset="utf-8"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;500;600;700&display=swap" rel="stylesheet"><style>${bundle.styles}</style></head><body>${bundle.sections}</body></html>`);
    doc.close();
    await waitForFrameAssets(doc);
    bundle.pageCount=await rebalanceAnnualTrainingPages(doc);
    return frame;
  }
  function dataUrlBytes(dataUrl){
    const base64=String(dataUrl||'').split(',')[1]||'',binary=atob(base64),bytes=new Uint8Array(binary.length);
    for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
    return bytes;
  }
  function canvasPngBytes(canvas){return dataUrlBytes(canvas.toDataURL('image/png',1));}
  function safeDownloadName(value){return String(value||'เอกสาร').replace(/[\\/:*?"<>|]+/g,'-').replace(/\s+/g,' ').trim();}
  function fitBox(width,height,maxWidth,maxHeight){const scale=Math.min(maxWidth/Math.max(width,1),maxHeight/Math.max(height,1));return {width:width*scale,height:height*scale};}
  function wrapCanvasText(ctx,text,maxWidth){
    const words=String(text||'').split(/\s+/).filter(Boolean),lines=[];let line='';
    for(const word of words){const test=line?`${line} ${word}`:word;if(ctx.measureText(test).width<=maxWidth||!line)line=test;else{lines.push(line);line=word;}}
    if(line)lines.push(line);return lines.slice(0,2);
  }
  async function certificateHeaderImage(pdfDoc,item,index,total){
    const canvas=document.createElement('canvas');canvas.width=1600;canvas.height=190;
    const ctx=canvas.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.strokeStyle='#222';ctx.lineWidth=2;ctx.strokeRect(1,1,canvas.width-2,canvas.height-2);
    ctx.fillStyle='#111';ctx.textBaseline='top';ctx.font='700 44px "TH Sarabun New",Sarabun,Tahoma,sans-serif';ctx.fillText(`เอกสารแนบลำดับที่ ${index} จาก ${total}`,40,22);
    ctx.font='600 36px "TH Sarabun New",Sarabun,Tahoma,sans-serif';const lines=wrapCanvasText(ctx,item.activity.title||'-',canvas.width-80);lines.forEach((line,i)=>ctx.fillText(line,40,78+i*39));
    ctx.font='400 28px "TH Sarabun New",Sarabun,Tahoma,sans-serif';ctx.textAlign='right';ctx.fillText(`${dateLabel(item.activity.start_date)}${dateKey(item.activity.end_date)!==dateKey(item.activity.start_date)?' – '+dateLabel(item.activity.end_date):''}`,canvas.width-40,28);ctx.textAlign='left';
    return pdfDoc.embedPng(canvasPngBytes(canvas));
  }
  async function downloadCertificate(record){
    const path=String(record?.certificate_path||'').trim();if(!path)throw new Error('ไม่พบที่อยู่ไฟล์ Certificate');
    if(/^https?:\/\//i.test(path)){const res=await fetch(path,{credentials:'include'});if(!res.ok)throw new Error(`ดาวน์โหลด Certificate ไม่สำเร็จ (${res.status})`);return res.blob();}
    const cleanPath=path.replace(/^staff-files\//,'').replace(/^\/+/,''),res=await DB().storage.from('staff-files').download(cleanPath);
    if(res.error)throw res.error;return res.data;
  }
  function certificateKind(record,blob){
    const mime=String(record?.certificate_mime_type||blob?.type||'').toLowerCase(),name=String(record?.certificate_name||record?.certificate_path||'').toLowerCase();
    if(mime.includes('pdf')||name.endsWith('.pdf'))return 'pdf';
    if(mime.startsWith('image/')||/\.(png|jpe?g|webp|gif|bmp|heic|heif)$/i.test(name))return 'image';
    return 'unknown';
  }
  async function blobToPngEmbed(pdfDoc,blob){
    const url=URL.createObjectURL(blob);try{
      const img=new Image();img.decoding='async';
      const loaded=new Promise((resolve,reject)=>{img.onload=()=>resolve();img.onerror=()=>reject(new Error('เปิดไฟล์รูป Certificate ไม่สำเร็จ'));});
      img.src=url;if(typeof img.decode==='function')await img.decode().catch(()=>loaded);else await loaded;
      const sourceWidth=img.naturalWidth||img.width,sourceHeight=img.naturalHeight||img.height,maxSide=3000,scale=Math.min(1,maxSide/Math.max(sourceWidth,sourceHeight));
      const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(sourceWidth*scale));canvas.height=Math.max(1,Math.round(sourceHeight*scale));
      const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(img,0,0,canvas.width,canvas.height);
      return pdfDoc.embedPng(canvasPngBytes(canvas));
    }finally{URL.revokeObjectURL(url);}
  }
  async function appendCertificatePdf(pdfDoc,blob,item,index,total){
    const bytes=new Uint8Array(await blob.arrayBuffer()),source=await PDFLib.PDFDocument.load(bytes,{ignoreEncryption:false}),sourcePages=source.getPages(),indices=sourcePages.map((_,i)=>i),embedded=await pdfDoc.embedPdf(bytes,indices),header=await certificateHeaderImage(pdfDoc,item,index,total);
    const A4W=595.28,A4H=841.89,margin=28,headerH=68,gap=10,maxW=A4W-margin*2,maxH=A4H-margin*2-headerH-gap;
    embedded.forEach((embeddedPage,i)=>{const page=pdfDoc.addPage([A4W,A4H]),size=sourcePages[i].getSize(),fit=fitBox(size.width,size.height,maxW,maxH);page.drawImage(header,{x:margin,y:A4H-margin-headerH,width:maxW,height:headerH});page.drawPage(embeddedPage,{x:(A4W-fit.width)/2,y:margin+(maxH-fit.height)/2,width:fit.width,height:fit.height});});
  }
  async function appendCertificateImage(pdfDoc,blob,item,index,total){
    const image=await blobToPngEmbed(pdfDoc,blob),header=await certificateHeaderImage(pdfDoc,item,index,total),A4W=595.28,A4H=841.89,margin=28,headerH=68,gap=10,maxW=A4W-margin*2,maxH=A4H-margin*2-headerH-gap,fit=fitBox(image.width,image.height,maxW,maxH),page=pdfDoc.addPage([A4W,A4H]);
    page.drawImage(header,{x:margin,y:A4H-margin-headerH,width:maxW,height:headerH});page.drawImage(image,{x:(A4W-fit.width)/2,y:margin+(maxH-fit.height)/2,width:fit.width,height:fit.height});
  }
  function fmMergeLineSegments(raw){
    const groups=new Map(),round=v=>Math.round(v*4)/4;
    for(const seg of raw){
      const horizontal=Math.abs(seg.y2-seg.y1)<=0.5;
      const fixed=round(horizontal?(seg.y1+seg.y2)/2:(seg.x1+seg.x2)/2);
      const start=round(horizontal?Math.min(seg.x1,seg.x2):Math.min(seg.y1,seg.y2));
      const end=round(horizontal?Math.max(seg.x1,seg.x2):Math.max(seg.y1,seg.y2));
      const key=`${horizontal?'h':'v'}:${fixed}`;
      if(!groups.has(key))groups.set(key,{horizontal,fixed,ranges:[]});
      groups.get(key).ranges.push([start,end]);
    }
    const merged=[];
    for(const group of groups.values()){
      group.ranges.sort((a,b)=>a[0]-b[0]);
      const ranges=[];
      for(const range of group.ranges){
        const last=ranges[ranges.length-1];
        if(last&&range[0]<=last[1]+0.75)last[1]=Math.max(last[1],range[1]);
        else ranges.push(range.slice());
      }
      for(const [start,end] of ranges){
        merged.push(group.horizontal?{x1:start,y1:group.fixed,x2:end,y2:group.fixed}:{x1:group.fixed,y1:start,x2:group.fixed,y2:end});
      }
    }
    return merged;
  }
  function fmVectorLineGeometry(pageElement){
    const pageRect=pageElement.getBoundingClientRect(),raw=[];
    const addLine=(x1,y1,x2,y2)=>raw.push({x1:x1-pageRect.left,y1:y1-pageRect.top,x2:x2-pageRect.left,y2:y2-pageRect.top});
    const addRect=element=>{
      const r=element.getBoundingClientRect();
      addLine(r.left,r.top,r.right,r.top);addLine(r.right,r.top,r.right,r.bottom);
      addLine(r.left,r.bottom,r.right,r.bottom);addLine(r.left,r.top,r.left,r.bottom);
    };
    pageElement.querySelectorAll('.fm-header td,.fm-training th,.fm-training td').forEach(addRect);
    const person=pageElement.querySelector('.fm-person');if(person)addRect(person);
    pageElement.querySelectorAll('.fm-fill-line').forEach(element=>{const r=element.getBoundingClientRect();addLine(r.left,r.bottom,r.right,r.bottom);});
    return {width:pageRect.width,height:pageRect.height,segments:fmMergeLineSegments(raw)};
  }
  function drawFmVectorLines(pdfPage,geometry,fit,x,y){
    if(!geometry?.segments?.length||!geometry.width||!geometry.height)return;
    const scaleX=fit.width/geometry.width,scaleY=fit.height/geometry.height,color=window.PDFLib.rgb(0,0,0);
    for(const seg of geometry.segments){
      pdfPage.drawLine({
        start:{x:x+seg.x1*scaleX,y:y+fit.height-seg.y1*scaleY},
        end:{x:x+seg.x2*scaleX,y:y+fit.height-seg.y2*scaleY},
        thickness:0.5,
        color
      });
    }
  }
  function triggerBlobDownload(blob,fileName){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=safeDownloadName(fileName);document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),15000);}
  async function buildAnnualTrainingPdf(items,options={},onProgress=()=>{}){
    const bundle=annualFormDocument(items,options);if(!bundle)throw new Error('ข้อมูลบุคลากรหรือปีแบบฟอร์มไม่ครบ');
    if(!window.PDFLib?.PDFDocument||typeof window.html2canvas!=='function')throw new Error('ยังโหลดระบบสร้าง PDF ไม่สำเร็จ กรุณารีเฟรชแล้วลองใหม่');
    const certificates=(items||[]).filter(x=>x.record.certificate_path),errors=[];let frame;
    try{
      const pdfDoc=await PDFLib.PDFDocument.create();frame=await createAnnualFrame(bundle);const pages=[...frame.contentDocument.querySelectorAll('.fm-page')];if(!pages.length)throw new Error('ไม่พบหน้าตาราง FM-CNHR-002 สำหรับสร้าง PDF');const MM=72/25.4,A4W=210*MM,A4H=297*MM,marginX=5*MM,top=5*MM,maxW=200*MM,maxH=286*MM;
      for(let i=0;i<pages.length;i++){
        onProgress(`กำลังสร้างตาราง PDF ${i+1}/${pages.length}`);
        const pageElement=pages[i],lineGeometry=fmVectorLineGeometry(pageElement);pageElement.classList.add('fm-vector-line-capture');let canvas;
        try{canvas=await window.html2canvas(pageElement,{scale:3,backgroundColor:'#fff',useCORS:true,logging:false,scrollX:0,scrollY:0,width:pageElement.scrollWidth,height:pageElement.scrollHeight,windowWidth:pageElement.scrollWidth,windowHeight:pageElement.scrollHeight});}
        finally{pageElement.classList.remove('fm-vector-line-capture');}
        const image=await pdfDoc.embedPng(canvasPngBytes(canvas)),fit=fitBox(image.width,image.height,maxW,maxH),pdfPage=pdfDoc.addPage([A4W,A4H]),imageY=A4H-top-fit.height;
        pdfPage.drawImage(image,{x:marginX,y:imageY,width:fit.width,height:fit.height});drawFmVectorLines(pdfPage,lineGeometry,fit,marginX,imageY);
      }
      for(let i=0;i<certificates.length;i++){
        const item=certificates[i];onProgress(`กำลังแนบ Certificate ${i+1}/${certificates.length}`);
        try{const blob=await downloadCertificate(item.record),kind=certificateKind(item.record,blob);if(kind==='pdf')await appendCertificatePdf(pdfDoc,blob,item,i+1,certificates.length);else if(kind==='image')await appendCertificateImage(pdfDoc,blob,item,i+1,certificates.length);else throw new Error('ชนิดไฟล์ไม่รองรับ');}catch(error){errors.push(`${item.activity.title||'Certificate'}: ${error?.message||String(error)}`);}
      }
      onProgress('กำลังบันทึกไฟล์ PDF…');
      return {bytes:await pdfDoc.save(),bundle,errors,certificateCount:certificates.length};
    }finally{frame?.remove();}
  }
  async function exportMyAnnualTrainingPackage(items,button){
    if(!isMyTrainingFilterReady())return showToast('กรุณาเลือกสถานะข้อมูลและปีแบบฟอร์มก่อน');
    if(!items.length)return showToast(`ไม่พบรายการอบรมในปี ${selectedTrainingYear()+543}`);
    const originalText=button?.textContent||'';
    try{
      if(button)button.disabled=true;
      const built=await buildAnnualTrainingPdf(items,{staffId:actor(),year:selectedTrainingYear()},text=>{if(button)button.textContent=text;});
      triggerBlobDownload(new Blob([built.bytes],{type:'application/pdf'}),`FM-CNHR-002_${built.bundle.personName}_${built.bundle.year+543}_พร้อม-Certificate.pdf`);
      if(built.errors.length){console.warn('V421 certificate merge skipped',built.errors);showToast(`สร้าง PDF แล้ว แต่แนบ Certificate ไม่สำเร็จ ${built.errors.length} ไฟล์`);}else showToast(`สร้าง PDF ชุดอบรมแล้ว • แนบ Certificate ${built.certificateCount} ไฟล์`);
    }catch(error){console.error('V421 annual training PDF',error);showToast(`สร้าง PDF ไม่สำเร็จ: ${error?.message||String(error)}`);}finally{if(button){button.disabled=false;button.textContent=originalText||'Export PDF ชุดอบรมประจำปี';}}
  }
  function adminExportYear(){const from=Number(String(S().v396From||'').slice(0,4)),to=Number(String(S().v396To||'').slice(0,4));return from&&from===to?from:0;}
  async function exportAdminAnnualTrainingPackage(button){
    if(!adminFiltersReady())return showToast('กรุณาเลือกบุคลากรและสถานะข้อมูลก่อน');
    const year=adminExportYear();if(!year)return showToast('กรุณาเลือกช่วงวันที่ให้อยู่ภายในปีเดียวกัน');
    const s=S(),rows=filtered(),activeStaff=(S().staff||[]).filter(x=>x.is_active!==false),targets=s.v396Staff==='all'?activeStaff:[staffOf(s.v396Staff)].filter(x=>x.id),groups=[];
    for(const person of targets){const items=rows.filter(x=>idEq(x.record.staff_id,person.id)).sort((a,b)=>dateKey(a.activity.start_date).localeCompare(dateKey(b.activity.start_date)));if(items.length||s.v396Status==='all')groups.push({staffId:person.id,items});}
    if(!groups.length)return showToast('ไม่พบข้อมูลสำหรับ Export ตามตัวกรอง');
    const originalText=button?.textContent||'',allPeople=s.v396Staff==='all',errors=[];
    try{
      if(button)button.disabled=true;
      if(!allPeople&&groups.length===1){
        const group=groups[0],built=await buildAnnualTrainingPdf(group.items,{staffId:group.staffId,year},text=>{if(button)button.textContent=text;});
        triggerBlobDownload(new Blob([built.bytes],{type:'application/pdf'}),`FM-CNHR-002_${built.bundle.personName}_${year+543}_พร้อม-Certificate.pdf`);errors.push(...built.errors.map(x=>`${built.bundle.personName}: ${x}`));
      }else{
        if(!window.JSZip)throw new Error('ยังโหลดระบบรวมไฟล์ ZIP ไม่สำเร็จ กรุณารีเฟรชแล้วลองใหม่');
        const zip=new JSZip();
        for(let i=0;i<groups.length;i++){
          const group=groups[i],name=staffOf(group.staffId).full_name||staffName(group.staffId);if(button)button.textContent=`กำลังสร้าง ${i+1}/${groups.length}: ${name}`;
          const built=await buildAnnualTrainingPdf(group.items,{staffId:group.staffId,year},text=>{if(button)button.textContent=`${i+1}/${groups.length} • ${text}`;});
          zip.file(safeDownloadName(`FM-CNHR-002_${built.bundle.personName}_${year+543}_พร้อม-Certificate.pdf`),built.bytes);errors.push(...built.errors.map(x=>`${built.bundle.personName}: ${x}`));
        }
        if(button)button.textContent='กำลังรวมไฟล์ ZIP…';const zipBlob=await zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:6}});triggerBlobDownload(zipBlob,`FM-CNHR-002_เจ้าหน้าที่ทุกคน_${year+543}_พร้อม-Certificate.zip`);
      }
      if(errors.length){console.warn('V421 admin certificate merge skipped',errors);showToast(`Export สำเร็จ แต่แนบ Certificate ไม่สำเร็จ ${errors.length} ไฟล์`);}else showToast(`Export FM-CNHR-002 สำเร็จ ${groups.length} คน`);
    }catch(error){console.error('V421 admin annual training export',error);showToast(`Export ไม่สำเร็จ: ${error?.message||String(error)}`);}finally{if(button){button.disabled=false;button.textContent=originalText||(allPeople?'Export PDF ทุกคน':'Export PDF บุคลากรที่เลือก');}}
  }
  function printMyAnnualForm(items,button){return exportMyAnnualTrainingPackage(items,button);}


  let v417LastPage='';
  function resetTrainingFiltersOnEntry(page){
    const s=S(),year=currentGregorianYear();
    if(page==='myTraining'){s.v402MyStatus='รอกรอกข้อมูล';s.v407TrainingYear='';s.v396MyFrom='';s.v396MyTo='';s.v417MyTrainingPage=1;}
    if(page==='trainingAdmin'){s.v396From=`${year}-01-01`;s.v396To=`${year}-12-31`;s.v396Staff='';s.v396Status='';}
  }
  function renderPageV396(){const p=S().page;if(p==='myTraining'||p==='trainingAdmin'){if(v417LastPage!==p)resetTrainingFiltersOnEntry(p);v417LastPage=p;const item=NAV_ITEMS.find(x=>x.id===p);$('pageTitle').textContent=item.title;$('pageSubtitle').textContent=item.subtitle;renderNav();$('pageContent').innerHTML=p==='myTraining'?renderMyTraining():renderTrainingAdmin();return;}v417LastPage=p;return oldRenderPage.apply(this,arguments);}
  const oldRenderPage=window.renderPage||renderPage;window.renderPage=renderPageV396;try{(0,eval)('renderPage=window.renderPage');}catch(_){ }
  NAV_ITEMS.splice(NAV_ITEMS.findIndex(x=>x.id==='activities')+1,0,{id:'myTraining',icon:'🎓',title:'รายการอบรมของฉัน',subtitle:'กรอกผลการอบรมและ Export FM-CNHR-002',group:'staff'});NAV_ITEMS.push({id:'trainingAdmin',icon:'🧾',title:'ตรวจสอบอบรมของเจ้าหน้าที่',subtitle:'Admin/แพทย์กรองและ Export ประวัติอบรม',group:'admin'});
  const oldNav=window.renderNav||renderNav;window.renderNav=function(){oldNav.apply(this,arguments);if(isManager()&&!document.querySelector('[data-page="trainingAdmin"]')){const nav=document.getElementById('mainNav');if(nav)nav.insertAdjacentHTML('beforeend','<div class="nav-section v396-doctor-nav"><div class="nav-section-title"><span>เมนู Admin/แพทย์</span><small>ตรวจสอบข้อมูลอบรม</small></div><button class="nav-btn" data-page="trainingAdmin"><span class="nav-emoji">🧾</span><span>ตรวจสอบอบรมของเจ้าหน้าที่</span></button></div>');}};try{(0,eval)('renderNav=window.renderNav');}catch(_){ }

  async function saveRecord(form){const r=trainingRows().find(x=>idEq(x.id,form.dataset.v396Record));if(!r||(!idEq(r.staff_id,actor())&&!isManager()))return showToast('ไม่มีสิทธิ์แก้ไขรายการนี้');const fd=new FormData(form),patch={result_text:String(fd.get('result_text')||'').trim()||null,application_text:String(fd.get('application_text')||'').trim()||null,updated_by:actor()};try{const file=fd.get('certificate');if(file?.size){const safe=String(file.name||'certificate').replace(/[^a-zA-Z0-9._-]/g,'_');const path=`training-certificates/${r.staff_id}/${r.id}_${Date.now()}_${safe}`;const up=await DB().storage.from('staff-files').upload(path,file,{upsert:false});if(up.error)throw up.error;patch.certificate_path=path;patch.certificate_name=file.name;patch.certificate_mime_type=file.type||null;}const res=await DB().from(TABLE).update(patch).eq('id',r.id);if(res.error)throw res.error;await loadTraining();renderPage();showToast('บันทึกข้อมูลอบรมแล้ว');}catch(e){showToast(e?.message||String(e));}}
  document.addEventListener('submit',e=>{if(e.target?.id==='activityForm'){e.preventDefault();e.stopImmediatePropagation();saveActivityV396(e.target);}else if(e.target?.matches?.('[data-v396-record]')){e.preventDefault();e.stopImmediatePropagation();saveRecord(e.target);}else if(e.target?.id==='newStaffForm'){const date=e.target.querySelector('[name="employment_start_date"]')?.value||'';if(date){e.preventDefault();e.stopImmediatePropagation();const fd=new FormData(e.target);(async()=>{const row={nickname:fd.get('nickname'),full_name:fd.get('full_name'),email:String(fd.get('email')||'').trim().toLowerCase(),employee_code:fd.get('employee_code')||null,phone:fd.get('phone')||null,login_name:fd.get('login_name')||null,staff_color:fd.get('staff_color')||'#e8f3ff',staff_type:fd.get('staff_type')||null,position:fd.get('position')||null,role:fd.get('role')||'staff',is_active:true,roster_enabled:true,daily_position_enabled:false,position_training_status:'น้องใหม่ / ยังไม่จัดอัตโนมัติ',employment_start_date:date};const q=await DB().from('staff_profiles').insert(row);if(q.error)return showToast(q.error.message);await loadAllData();renderPage();showToast('เพิ่มผู้ใช้งานพร้อมวันเริ่มงานแล้ว');})();}}},true);
  document.addEventListener('change',e=>{if(e.target?.name==='include_fm_cnhr_002'){const wrap=e.target.closest('.v405-training-meta-grid'),required=e.target.checked===true;wrap?.querySelectorAll('.v405-training-field').forEach(field=>{field.classList.toggle('v405-required',required);const input=field.querySelector('input');if(input){input.required=required;input.setAttribute('aria-required',required?'true':'false');}});const batchInput=wrap?.querySelector('input[name="training_batch"]');if(required&&batchInput&&!String(batchInput.value||'').trim())batchInput.value='-';return;}if(e.target?.id==='v407TrainingYear'){applyTrainingYearRange(e.target.value);S().v417MyTrainingPage=1;renderPage();return;}const m={v402MyStatus:'v402MyStatus',v396MyFrom:'v396MyFrom',v396MyTo:'v396MyTo',v396From:'v396From',v396To:'v396To',v396Staff:'v396Staff',v396Status:'v396Status'};if(m[e.target?.id]){S()[m[e.target.id]]=e.target.value||'';if(e.target.id==='v402MyStatus')S().v417MyTrainingPage=1;renderPage();}},true);
  document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.hasAttribute('data-v402-my-export')){e.preventDefault();e.stopImmediatePropagation();printMyAnnualForm(myTrainingAnnualRows(),b);}else if(b.hasAttribute('data-v396-admin-export')){e.preventDefault();e.stopImmediatePropagation();exportAdminAnnualTrainingPackage(b);}else if(b.hasAttribute('data-v417-my-page')){e.preventDefault();e.stopImmediatePropagation();const totalPages=Math.max(1,Math.ceil(myTrainingRows().length/MY_TRAINING_PAGE_SIZE)),requested=Number(b.getAttribute('data-v417-my-page'));S().v417MyTrainingPage=Math.min(totalPages,Math.max(1,Number.isInteger(requested)?requested:1));renderPage();window.scrollTo?.({top:0,behavior:'smooth'});}},true);
  // staff_profiles ในฐานข้อมูลจริงไม่มี updated_by จึงห้ามส่งฟิลด์นี้ไปตอน Active/ข้อมูลผู้ใช้งาน
  document.addEventListener('click',e=>{const b=e.target.closest('button[data-save-staff-users]');if(!b)return;e.preventDefault();e.stopImmediatePropagation();(async()=>{const card=document.querySelector('[data-staff-row]'),id=S().usersStaffId;if(!card||!id)return;const get=k=>card.querySelector(`[data-field="${k}"]`)?.value;const patch={nickname:get('nickname'),full_name:get('full_name'),email:get('email'),employee_code:get('employee_code'),phone:get('phone'),login_name:get('login_name')||null,staff_color:get('staff_color'),staff_type:get('staff_type'),position:get('position'),role:get('role'),is_active:get('is_active')==='true',roster_enabled:get('roster_enabled')!=='false',daily_position_enabled:get('daily_position_enabled')!=='false',is_long_term_leave:get('is_long_term_leave')==='true',position_training_status:get('position_training_status'),employment_start_date:get('employment_start_date')||null};const q=await DB().from('staff_profiles').update(patch).eq('id',id);if(q.error)return showToast(q.error.message);await loadAllData();renderPage();showToast('บันทึกข้อมูลผู้ใช้งานและวันเริ่มงานแล้ว');})();},true);

  const oldProfile=window.renderMyProfilePage||renderMyProfilePage;window.renderMyProfilePage=function(){const html=oldProfile.apply(this,arguments);return html.replace('</div>','<div class="card"><h3>วันเริ่มงาน</h3><p>'+esc(employment(actor())||'ยังไม่ระบุ')+'</p><span class="hint">ข้อมูลนี้ใช้เป็นข้อมูลตั้งต้นในแบบฟอร์ม FM-CNHR-002</span></div></div>');};try{(0,eval)('renderMyProfilePage=window.renderMyProfilePage');}catch(_){ }
  const oldUsers=window.renderUsersPage||renderUsersPage;window.renderUsersPage=function(){let html=oldUsers.apply(this,arguments);html=html.replace('<label>Email <input data-field="email"','<label>วันเริ่มงาน <input type="date" data-field="employment_start_date" value="'+esc(staffOf(S().usersStaffId).employment_start_date||'')+'"></label><label>Email <input data-field="email"');html=html.replace('<label>ชื่อเล่น <input name="nickname"','<label>วันเริ่มงาน <input name="employment_start_date" type="date"></label><label>ชื่อเล่น <input name="nickname"');return html;};try{(0,eval)('renderUsersPage=window.renderUsersPage');}catch(_){ }
  const oldLeaveBadge=window.leaveCellBadge||leaveCellBadge;window.leaveCellBadge=function(l){const text=leaveDisplayType(l),period=String(l?.leave_period||'เต็มวัน');return `<span class="mini-status ${leaveCellClass(text)}">${esc(text)}${period!=='เต็มวัน'?`<small class="v396-halfday">${esc(period.replace(/\\s*\\d{2}:\\d{2}-\\d{2}:\\d{2}/,'').trim())}</small>`:''}</span>`;};try{(0,eval)('leaveCellBadge=window.leaveCellBadge');}catch(_){ }
  const oldEventText=window.eventText||eventText;window.eventText=function(type){return oldEventText(type);};
  const style=document.createElement('style');style.textContent=`
    .v396-participants{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;max-height:240px;overflow:auto}.v396-participant{display:flex;gap:8px;padding:8px;border:1px solid #d9e4ed;border-radius:10px;background:#fff}.v396-participant input{width:auto}.v396-participant span{display:grid}.v396-participant small{color:#68798a}.v405-training-meta-grid{display:grid;grid-template-columns:minmax(260px,1.15fr) minmax(220px,1fr) minmax(170px,.72fr);gap:12px;align-items:stretch}.v396-training-check{display:flex;gap:9px;align-items:flex-start;padding:12px;border:1px solid #9bc8e2;border-radius:12px;background:#f2faff;font-weight:700;margin:0}.v396-training-check input{width:auto;margin-top:4px}.v396-training-check small{display:block;font-weight:400;color:#587087}.v405-training-field{display:grid;align-content:start;gap:5px;padding:10px 12px;border:1px solid #d9e4ed;border-radius:12px;background:#fff;margin:0}.v405-training-field input{margin-top:0}.v405-required-mark{display:none;color:#c93b52}.v405-training-field.v405-required{border-color:#75bce6;background:#f8fcff}.v405-training-field.v405-required .v405-required-mark{display:inline}
    .v396-record-list{display:grid;gap:16px;margin-top:16px}.v396-record textarea{width:100%;resize:vertical}.v396-filters{align-items:end}.v401-my-training-filters{grid-template-columns:repeat(2,minmax(180px,260px));justify-content:start}.v402-my-training-filters{display:grid;grid-template-columns:minmax(180px,230px) minmax(200px,250px) minmax(280px,1fr);align-items:end;gap:12px}.v402-export-wrap{display:grid;gap:5px;align-content:end}.v402-export-wrap button{width:100%}.v402-export-wrap button:disabled,.section-title button:disabled{opacity:.48;cursor:not-allowed}.v396-halfday{display:block;font-size:10px;font-weight:700}
    .v417-my-training-filters{align-items:start}.v417-my-training-filters>label,.v417-my-training-filters>.v402-export-wrap{display:grid;grid-template-rows:auto 42px;gap:6px;align-content:start;margin:0}.v417-control-label{display:block;font-weight:700;color:#263e50;line-height:1.2}.v417-my-training-filters select,.v417-my-training-filters button{height:42px;min-height:42px;margin:0}.v417-training-pagination{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:14px}.v417-training-pagination span{min-width:78px;text-align:center;color:#607789;font-size:.86rem;font-weight:700}.v417-page-btn{min-height:32px!important;padding:5px 12px!important;border-radius:9px!important;font-size:.84rem!important}.v417-page-btn:disabled{opacity:.42;cursor:not-allowed}
    .v416-filter-gate,.v416-admin-training-filters{border:1px solid #d7e6f0;background:#f8fbfd;border-radius:14px;padding:12px}.v416-admin-training-filters{display:grid;grid-template-columns:repeat(4,minmax(170px,1fr));gap:12px}.v416-selection-prompt{margin-top:16px;min-height:150px;border:1px dashed #9fc6de;border-radius:16px;background:linear-gradient(180deg,#f8fcff,#fff);display:flex;align-items:center;justify-content:center;gap:14px;padding:24px;color:#24455f;text-align:left}.v416-selection-prompt b{display:block;font-size:1.05rem}.v416-selection-prompt small{display:block;margin-top:4px;color:#6b7f90}.v416-selection-icon{width:42px;height:42px;border-radius:50%;display:grid;place-items:center;background:#e4f4ff;color:#1681bf;font-size:28px;font-weight:700}
    .v416-training-card{padding:0;overflow:hidden;border:1px solid #d7e3ec;box-shadow:0 8px 24px rgba(32,77,108,.06)}.v416-training-card-pending{border-left:4px solid #f0ad4e}.v416-training-card-complete{border-left:4px solid #4caf7d}.v416-record-head{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:16px;padding:16px 18px 12px}.v416-record-heading{min-width:0}.v416-record-heading h3{margin:4px 0 0;line-height:1.35;font-size:1.02rem}.v416-record-number{display:inline-block;font-size:.75rem;font-weight:700;color:#4c718b;background:#eef7fc;border-radius:999px;padding:3px 9px}.v416-record-status{padding-top:2px;white-space:nowrap}.v416-record-meta{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:0;border-top:1px solid #e5edf3;border-bottom:1px solid #e5edf3;background:#f8fbfd}.v416-record-meta span{min-width:0;padding:9px 12px;border-right:1px solid #e5edf3;font-size:.82rem;line-height:1.35;overflow-wrap:anywhere}.v416-record-meta span:last-child{border-right:0}.v416-record-meta b{display:block;color:#587086;font-size:.72rem;margin-bottom:2px}.v416-record-form{padding:14px 18px 16px}.v416-record-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;align-items:stretch}.v416-answer-field{display:grid;grid-template-rows:auto auto minmax(112px,1fr);gap:5px;margin:0;padding:12px;border:1px solid #cfe0eb;border-radius:13px;background:#fff}.v416-answer-field:focus-within{border-color:#58ace0;box-shadow:0 0 0 3px rgba(88,172,224,.12);background:#fbfeff}.v416-field-title{font-weight:700;color:#193d56}.v416-answer-field small,.v416-certificate-field small,.v416-save-area small{color:#718493;font-weight:400}.v416-answer-field textarea{min-height:112px;height:112px;margin:2px 0 0;border-radius:10px;background:#fbfdff}.v416-record-bottom{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px;align-items:end;margin-top:12px;padding-top:12px;border-top:1px solid #e7eef3}.v416-certificate-field{display:grid;gap:5px;margin:0}.v416-certificate-field input{max-width:100%}.v416-file-current{color:#277857!important}.v416-save-area{display:grid;gap:6px;justify-items:end;text-align:right}.v416-save-area button{min-width:170px}
    @media(max-width:1050px){.v416-admin-training-filters{grid-template-columns:repeat(2,minmax(180px,1fr))}.v416-record-meta{grid-template-columns:repeat(2,minmax(0,1fr))}.v416-record-meta span:nth-child(2){border-right:0}.v416-record-meta span:nth-child(-n+2){border-bottom:1px solid #e5edf3}}
    @media(max-width:900px){.v405-training-meta-grid{grid-template-columns:1fr}.v402-my-training-filters{grid-template-columns:1fr 1fr}.v402-export-wrap{grid-column:1/-1}}
    @media(max-width:700px){.v396-participants{grid-template-columns:1fr}.v396-filters{display:grid;grid-template-columns:1fr 1fr}.v396-filters label:last-child{grid-column:1/-1}.v401-my-training-filters label:last-child{grid-column:auto}.v402-my-training-filters label:last-of-type{grid-column:auto}.v407-year-filter .v402-export-wrap{grid-column:1/-1}.v416-record-form-grid{grid-template-columns:1fr}.v416-record-bottom{grid-template-columns:1fr}.v416-save-area{justify-items:stretch;text-align:left}.v416-save-area button{width:100%}.v416-record-head{gap:10px}.v416-record-meta{grid-template-columns:1fr}.v416-record-meta span{border-right:0!important;border-bottom:1px solid #e5edf3}.v416-record-meta span:last-child{border-bottom:0}.v417-training-pagination{justify-content:center}}
    @media(max-width:460px){.v401-my-training-filters,.v402-my-training-filters,.v416-admin-training-filters{grid-template-columns:1fr}.v401-my-training-filters label:last-child,.v402-my-training-filters label:last-of-type,.v402-export-wrap{grid-column:1/-1}.v416-record-head{grid-template-columns:1fr}.v416-record-status{justify-self:start}.v416-selection-prompt{align-items:flex-start;padding:18px}.v416-record-form,.v416-record-head{padding-left:13px;padding-right:13px}}
  `;document.head.appendChild(style);
  loadTraining();
})();
