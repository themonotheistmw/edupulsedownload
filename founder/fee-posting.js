// Shared by the School and Founder interfaces. The rules check the old totals
// and the receipt reference against the same atomic multi-location update.
async function postSchoolFee(db, school, student, request, actor, day) {
  const schoolRef = db.ref('schools_platform_v1/schools/' + school);
  const studentRef = schoolRef.child('students').child(student);
  const receipts = schoolRef.child('payments').child(student);
  const reversing = request.type === 'REVERSAL';
  const entryRef = receipts.child(request.id);
  if (!Number.isSafeInteger(request.amountPaise) || request.amountPaise <= 0) throw Error('Enter a positive amount.');
  if (!request.receiptNo) {
    const count = await schoolRef.child('receiptCounter').transaction(n => (Number(n) || 100) + 1);
    const prefix = request.type === 'WAIVER' ? 'WVR' : school.split('-')[0];
    request.receiptNo = prefix + '-' + day.slice(0, 4) + '-' + count.snapshot.val();
  }
  const existing = () => entryRef.get().then(s => s.val());
  const same = row => row && row.recordedBy === actor && row.type === request.type && row.amountPaise === request.amountPaise && row.receiptNo === request.receiptNo;
  for (let attempt = 0; attempt < 3; attempt++) {
    const saved = await existing();
    if (same(saved)) return saved.receiptNo;
    if (saved) throw Error('This receipt has already been processed.');
    const current = (await studentRef.get()).val();
    if (!current) throw Error('Student record unavailable.');
    const before = Number(current.feeBalance || 0);
    const paid = Number(current.totalPaid || 0);
    if (![before, paid].every(n => Number.isFinite(n) && n >= 0)) throw Error('Check the existing student fee totals.');
    const amount = request.amountPaise / 100;
    let applied = Math.min(before, amount);
    if (reversing) {
      const all = (await receipts.get()).val() || {};
      const original = all[request.originalId];
      if (!original || original.type !== 'PAYMENT' || original.amountPaise !== request.amountPaise ||
          request.receiptNo !== 'REV-' + original.receiptNo) throw Error('Original payment does not match.');
      if (Object.values(all).some(r => r.type === 'REVERSAL' && r.receiptNo === request.receiptNo)) throw Error('This receipt is already reversed.');
      applied = original.balanceApplied ?? amount;
    }
    const balance = reversing ? before + applied : before - applied;
    const total = reversing ? Math.max(0, paid - amount) : request.type === 'PAYMENT' ? paid + amount : paid;
    const payment = { ...request, recordedBy: actor, paidDate: day, recordedAt: firebase.database.ServerValue.TIMESTAMP,
      previousBalance: current.feeBalance ?? null, previousPaid: current.totalPaid ?? null,
      balanceApplied: applied, balanceAfter: balance, paidAfter: total };
    const patch = { ['payments/' + student + '/' + request.id]: payment };
    const fields = { feeBalance: balance, totalPaid: total, feeStatus: balance === 0 ? 'Paid' : 'Pending', lastFeeEntry: request.id };
    if (request.type === 'PAYMENT') Object.assign(fields, { lastPaymentAmount: amount, receiptNo: request.receiptNo, paidDate: day });
    for (const [field, value] of Object.entries(fields)) patch['students/' + student + '/' + field] = value;
    try {
      await schoolRef.update(patch);
      return request.receiptNo;
    } catch (err) {
      if (same(await existing())) return request.receiptNo;
      const latest = (await studentRef.get()).val();
      if (!latest || (latest.feeBalance === current.feeBalance && latest.totalPaid === current.totalPaid)) throw err;
    }
  }
  throw Error('Another fee entry changed the balance. Retry this payment.');
}

// Keep the same payment identity on a retry of the open payment form.
function feeRequest(form, db, details) {
  const key = JSON.stringify(details);
  if (form._feeKey !== key) {
    form._feeKey = key;
    form._feeRequest = { ...details, id: db.ref().push().key };
  }
  return form._feeRequest;
}
