
import assert from 'node:assert/strict';
import * as s from '../schemeLogic.js';
const base = {customerId:'RJTEST',schemeJoined:true,schemeStatus:'Active',
  schemeCycle:1,schemeFirstDueMonth:'2026-11',startDate:'2026-11-14',
  schemeAnchorDay:14,customInstallment:5000,paidMonths:0,paymentHistory:[]};
const states = () => Array.from({length:12},(_,i)=>({monthNum:i+1,paid:false,amount:5000}));
const test=(label,fn)=>{fn();console.log('PASS',label);};
test('first installment 14–18 November; cancelled from 19th',()=>{
  const rows=s.installmentRows(base,'2026-11-18');
  assert.equal(rows[0].status,'PAYMENT_DUE');
  assert.equal(rows[0].lastDate,'2026-11-18');
  assert.equal(s.overdueRows(base,'2026-11-19')[0].monthNum,1);
});
test('next installment 14–18 December',()=>{
  const r=s.installmentRows(base,'2026-12-14')[1];
  assert.equal(r.dueDate,'2026-12-14');assert.equal(r.lastDate,'2026-12-18');
});
test('pay 3 future installments at once',()=>{
  const c={...base,installmentState:states()};
  for (const n of [1,2,3]) c.installmentState[n-1].paid=true;
  assert.equal(s.paidCount(c),3);
  assert.deepEqual(s.overdueRows(c,'2027-01-19').map(x=>x.monthNum),[]);
  assert.equal(s.installmentRows(c,'2027-02-14')[3].status,'PAYMENT_DUE');
});
test('all 12 paid early stays benefit locked until 13th month',()=>{
  const c={...base,installmentState:states().map(x=>({...x,paid:true}))};
  assert.equal(s.paidCount(c),12);
  assert.equal(s.schemeBenefitDate(c),'2027-11-14');
  assert.equal(s.eligible(c,'2026-11-14'),false);
  assert.equal(s.eligible(c,'2027-11-13'),false);
  assert.equal(s.eligible(c,'2027-11-14'),true);
});
test('admin UNPAY locks benefit again',()=>{
  const c={...base,installmentState:states().map(x=>({...x,paid:true}))};
  c.installmentState[4].paid=false;
  assert.equal(s.eligible(c,'2027-11-14'),false);
  assert.equal(s.overdueRows(c,'2027-11-14')[0].monthNum,5);
  c.installmentState[4].paid=true;
  assert.equal(s.eligible(c,'2027-11-14'),true);
});
test('cancelled scheme cannot unlock benefit',()=>{
  const c={...base,schemeStatus:'Cancelled',installmentState:states().map(x=>({...x,paid:true}))};
  assert.equal(s.eligible(c,'2027-11-14'),false);
});
test('reactivation catch-up accepts missed payment immediately',()=>{
  const c={...base,schemeCatchupMonthNums:[1],schemeCatchupUntil:'2027-01-05'};
  assert.equal(s.installmentRows(c,'2027-01-02')[0].payableNow,true);
  assert.equal(s.installmentRows(c,'2027-01-06')[0].status,'OVERDUE');
});
test('join 31st uses last day in shorter month without drifting',()=>{
  const c={...base,schemeFirstDueMonth:'2026-01',startDate:'2026-01-31',schemeAnchorDay:31};
  assert.equal(s.dueDateFor(c,2),'2026-02-28');
  assert.equal(s.dueDateFor(c,3),'2026-03-31');
  assert.equal(s.schemeBenefitDate(c),'2027-01-31');
});
test('partial future prepayment does not skip unpaid earlier month',()=>{
  const c={...base,installmentState:states()};c.installmentState[2].paid=true;
  assert.equal(s.overdueRows(c,'2026-11-19')[0].monthNum,1);
});
test('per-customer anchor: join 3rd gives 3–7 every month',()=>{
  const c={...base,startDate:'2026-11-03',schemeAnchorDay:3};
  assert.equal(s.installmentRows(c,'2026-12-03')[1].dueDate,'2026-12-03');
  assert.equal(s.installmentRows(c,'2026-12-07')[1].lastDate,'2026-12-07');
});
