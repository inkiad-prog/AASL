const sql = require('mssql');

const BU_ID = 245;

const config = {
  server: process.env.MSSQL_SERVER,
  port: parseInt(process.env.MSSQL_PORT || '1433', 10),
  user: process.env.MSSQL_USER,
  password: process.env.MSSQL_PASSWORD,
  database: process.env.MSSQL_DATABASE,
  options: {
    encrypt: process.env.MSSQL_ENCRYPT === 'true',
    trustServerCertificate: process.env.MSSQL_TRUST_SERVER_CERTIFICATE === 'true',
  },
  connectionTimeout: 15000,
  requestTimeout: 30000,
};

let poolPromise;
function getPool() {
  if (!poolPromise) {
    poolPromise = sql.connect(config).catch((err) => {
      poolPromise = null;
      throw err;
    });
  }
  return poolPromise;
}

async function run(pool, query, params) {
  const request = pool.request();
  request.input('bu', sql.BigInt, BU_ID);
  if (params) {
    for (const key of Object.keys(params)) {
      request.input(key, params[key].type, params[key].value);
    }
  }
  const result = await request.query(query);
  return result.recordset;
}

// Verified once (2026-07) directly against the sub-ledger: sub-GL 21906 is named
// "Inter Company Interest Expense". Used to detect live whether Financial Expenses
// is still 100% intercompany, or whether a third-party (e.g. bank) sub-GL has appeared.
const INTERCOMPANY_INTEREST_SUBGL_ID = '21906';

function aggregateBudgetMonthly(rawRows) {
  const byMonth = {};
  const sellingSubGlSeries = {};
  const financialSubGlTotals = {};
  rawRows.forEach((r) => {
    const m = r.month;
    byMonth[m] = byMonth[m] || { month: m, revenue: 0, admin: 0, marketing: 0, depreciation: 0, financial: 0, tax: 0 };
    const amt = Number(r.amount) || 0;
    if (r.gl === 'Sales (Local)') byMonth[m].revenue += amt;
    else if (r.gl === 'Administrative Expenses') byMonth[m].admin += amt;
    else if (r.gl === 'Marketing Expenses') byMonth[m].marketing += amt;
    else if (r.gl && r.gl.indexOf('Depreciation') === 0) byMonth[m].depreciation += amt;
    else if (r.gl === 'Financial Expenses') {
      byMonth[m].financial += amt;
      const key = String(r.subGlId);
      financialSubGlTotals[key] = (financialSubGlTotals[key] || 0) + amt;
    }
    else if (r.gl === 'Tax Expenses') byMonth[m].tax += amt;
    else if (r.gl === 'Selling Expenses') {
      const key = String(r.subGlId);
      sellingSubGlSeries[key] = sellingSubGlSeries[key] || [];
      sellingSubGlSeries[key].push({ month: m, amount: amt });
    }
  });
  const sellingFixedPerMonth = {};
  const sellingCommissionPerMonth = {};
  Object.keys(sellingSubGlSeries).forEach((key) => {
    const series = sellingSubGlSeries[key];
    const amounts = series.map((s) => s.amount);
    const isFixed = amounts.every((a) => Math.abs(a - amounts[0]) < 0.01);
    series.forEach((s) => {
      if (isFixed) sellingFixedPerMonth[s.month] = (sellingFixedPerMonth[s.month] || 0) + s.amount;
      else sellingCommissionPerMonth[s.month] = (sellingCommissionPerMonth[s.month] || 0) + s.amount;
    });
  });

  const financialTotal = Object.values(financialSubGlTotals).reduce((a, v) => a + v, 0);
  const intercompanyTotal = financialSubGlTotals[INTERCOMPANY_INTEREST_SUBGL_ID] || 0;
  const otherSubGlIds = Object.keys(financialSubGlTotals).filter((k) => k !== INTERCOMPANY_INTEREST_SUBGL_ID);
  const financialExpenseBreakdown = {
    intercompanyAmount: intercompanyTotal,
    otherAmount: financialTotal - intercompanyTotal,
    intercompanyPct: financialTotal ? Math.abs(intercompanyTotal / financialTotal) * 100 : null,
    hasOtherFinancingSource: otherSubGlIds.length > 0 && Math.abs(financialTotal - intercompanyTotal) > 0.01,
  };

  const monthly = Object.keys(byMonth)
    .map((m) => ({
      ...byMonth[m],
      sellingFixed: sellingFixedPerMonth[m] || 0,
      sellingCommission: sellingCommissionPerMonth[m] || 0,
    }))
    .sort((a, b) => a.month - b.month);

  return { monthly, financialExpenseBreakdown };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
  try {
    const pool = await getPool();

    const monthly = await run(pool, `
      WITH j AS (
        SELECT
          FORMAT(dteTransactionDate,'yyyy-MM') AS period,
          numAmount,
          strGeneralLedgerName AS gl,
          CASE WHEN strGeneralLedgerName = 'Sales (Local)' AND (
              strNarration LIKE '%opup%' OR strNarration LIKE '%Balance-Forward%' OR strNarration LIKE '%Balance transfer%'
              OR strNarration LIKE '%Agent-Debit-Memo%' OR strNarration LIKE '%Refund%'
            ) THEN 1 ELSE 0 END AS isWalletMechanic
        FROM fin.tblAccountingJournal
        WHERE intBusinessUnitId = @bu AND isActive = 1
      )
      SELECT period,
        SUM(CASE WHEN gl='Sales (Local)' AND isWalletMechanic=0 THEN numAmount ELSE 0 END) AS clean_revenue,
        SUM(CASE WHEN gl='Sales (Local)' AND isWalletMechanic=1 THEN numAmount ELSE 0 END) AS wallet_mechanic,
        SUM(CASE WHEN gl='Selling Expenses' THEN numAmount ELSE 0 END) AS selling,
        SUM(CASE WHEN gl='Administrative Expenses' THEN numAmount ELSE 0 END) AS admin,
        SUM(CASE WHEN gl='Operating Expenses' THEN numAmount ELSE 0 END) AS operating,
        SUM(CASE WHEN gl='Financial Expenses' THEN numAmount ELSE 0 END) AS financial,
        SUM(CASE WHEN gl IN ('Depreciation on Property Plant & Equipment','Depreciation on Leased Asset','Amortization on Intangible Asset') THEN numAmount ELSE 0 END) AS depreciation,
        SUM(CASE WHEN gl='Marketing Expenses' THEN numAmount ELSE 0 END) AS marketing,
        -SUM(CASE WHEN gl='Other Income' THEN numAmount ELSE 0 END) AS other_income
      FROM j
      GROUP BY period
      ORDER BY period ASC`);

    const balanceSheet = await run(pool, `
      SELECT strGeneralLedgerName AS gl, SUM(numAmount) AS balance
      FROM fin.tblAccountingJournal
      WHERE intBusinessUnitId = @bu AND isActive = 1
      AND strGeneralLedgerName IN ('Cash at Bank','Trade Receivable (Local)','Payable against Suppliers',
        'Inter Company Balance','Investment','Advance Suppliers & Others','Payable against Expenses','Advances Income Tax')
      GROUP BY strGeneralLedgerName
      ORDER BY strGeneralLedgerName`);

    const bank = await run(pool, `
      SELECT ba.strBankName AS bankName, ba.strBankAccountName AS accountName, ba.strBankAccountNo AS accountNo,
        (SELECT TOP 1 s.monRunningBalance FROM fin.tblBankAccountStatement s
         WHERE s.intBankAccountId = ba.intBankAccountId ORDER BY s.dteBankTransectionDate DESC, s.intBankStatementId DESC) AS balance
      FROM fin.tblBankAccount ba
      WHERE ba.intBusinessUnitId = @bu AND ba.isActive = 1
      ORDER BY balance DESC`);

    const assets = await run(pool, `
      SELECT strAssetCategory AS category, SUM(numBookValue) AS bookValue, COUNT(*) AS cnt
      FROM ast.tblAsset
      WHERE intBusinessUnitId = @bu AND isActive = 1
      GROUP BY strAssetCategory
      ORDER BY bookValue DESC`);

    const assetCategories = await run(pool, `
      WITH buAssets AS (
        SELECT intAssetId, strAssetCategory, numAcquisitionValue, numBookValue
        FROM ast.tblAsset WHERE intBusinessUnitId = @bu AND isActive = 1
      ),
      depAgg AS (
        SELECT d.intAssetId, SUM(d.numDepreciation) AS totalDep
        FROM ast.tblAssetDepreciationRow d
        WHERE d.isActive = 1 AND d.intAssetId IN (SELECT intAssetId FROM buAssets)
        GROUP BY d.intAssetId
      )
      SELECT a.strAssetCategory AS category, COUNT(*) AS assets,
        SUM(a.numAcquisitionValue) AS acqValue,
        SUM(a.numBookValue) AS systemBookValue,
        SUM(ISNULL(d.totalDep,0)) AS accumDep
      FROM buAssets a
      LEFT JOIN depAgg d ON d.intAssetId = a.intAssetId
      GROUP BY a.strAssetCategory
      ORDER BY acqValue DESC`);

    const acBatch = await run(pool, `
      SELECT strItemName AS name, COUNT(*) AS qty, AVG(numAcquisitionValue) AS acqEach,
        MAX(CAST(intLifeTimeYear AS INT)) AS lifeYears
      FROM ast.tblAsset
      WHERE intBusinessUnitId = @bu AND isActive = 1 AND CAST(dteAcquisitionDate AS DATE) = '2025-12-29'
      GROUP BY strItemName
      ORDER BY acqEach DESC`);

    const vehicleAssetIds = await run(pool, `
      SELECT intAssetId FROM ast.tblAsset
      WHERE intBusinessUnitId = @bu AND isActive = 1 AND strAssetCategory = 'Building & Construction'
        AND strItemName LIKE '%Toyota Axio%'`);
    const vehicleIdList = vehicleAssetIds.map((r) => r.intAssetId).join(',') || '0';
    const vehicleMonthlyDep = await run(pool, `
      SELECT FORMAT(d.dtePeriodFrom,'yyyy-MM') AS period, SUM(d.numDepreciation) AS total
      FROM ast.tblAssetDepreciationRow d
      WHERE d.intAssetId IN (${vehicleIdList}) AND d.isActive = 1
      GROUP BY FORMAT(d.dtePeriodFrom,'yyyy-MM')
      ORDER BY period`);

    const segments = await run(pool, `
      WITH seg AS (
        SELECT COALESCE(NULLIF(strCostRevenueName,''),'(Unassigned)') AS segment,
          SUM(CASE WHEN strGeneralLedgerName LIKE '%Sales%' OR strGeneralLedgerName LIKE '%Income%' OR strGeneralLedgerName LIKE '%Royalty%' THEN numAmount ELSE 0 END) AS revenue,
          SUM(CASE WHEN strGeneralLedgerName NOT LIKE '%Sales%' AND strGeneralLedgerName NOT LIKE '%Income%' AND strGeneralLedgerName NOT LIKE '%Royalty%' AND numAmount > 0 THEN numAmount ELSE 0 END) AS expense
        FROM fin.tblAccountingJournal
        WHERE intBusinessUnitId = @bu AND isActive = 1 AND dteTransactionDate >= DATEADD(year,-1,GETDATE())
        GROUP BY COALESCE(NULLIF(strCostRevenueName,''),'(Unassigned)')
      )
      SELECT segment, revenue, expense FROM seg ORDER BY revenue + expense DESC`);

    const vendors = await run(pool, `
      SELECT TOP 15 strPartnerName AS partner, SUM(monTotalAmount) AS amount, COUNT(*) AS cnt
      FROM fin.tblBillRegister
      WHERE intBusinessUnitId = @bu AND isActive = 1 AND strPartnerName IS NOT NULL
      GROUP BY strPartnerName
      ORDER BY amount DESC`);

    const twoFactor = await run(pool, `
      SELECT strTransectionType AS type, isComplete AS complete, COUNT(*) AS cnt
      FROM dco.tblTwoFactorApproval
      WHERE intBusinessUnitId = @bu
      GROUP BY strTransectionType, isComplete`);

    const auditByMonth = await run(pool, `
      SELECT FORMAT(dteActionDateTime,'yyyy-MM') AS period, COUNT(*) AS cnt
      FROM dco.tblAuditLog
      WHERE intBusinessUnitId = @bu
      GROUP BY FORMAT(dteActionDateTime,'yyyy-MM')
      ORDER BY period DESC`);

    const employeeCountRows = await run(pool, `
      SELECT COUNT(*) AS employeeCount FROM dbo.vwEmployeeProfileAll WHERE intBusinessUnitId = @bu AND isActive = 1`);

    const taxLines = await run(pool, `
      SELECT strGeneralLedgerName AS gl, SUM(numAmount) AS balance
      FROM fin.tblAccountingJournal
      WHERE intBusinessUnitId = @bu AND isActive = 1
      AND (strGeneralLedgerName LIKE '%Tax%' OR strGeneralLedgerName LIKE '%VAT%')
      GROUP BY strGeneralLedgerName
      ORDER BY strGeneralLedgerName`);

    const relatedParty = await run(pool, `
      SELECT FORMAT(dteTransactionDate,'yyyy-MM') AS period,
        SUM(CASE WHEN strGeneralLedgerName LIKE '%Inter Company%Interest%' THEN numAmount ELSE 0 END) AS interestMove,
        SUM(CASE WHEN strGeneralLedgerName = 'Inter Company Balance' THEN numAmount ELSE 0 END) AS balanceMove
      FROM fin.tblAccountingJournal
      WHERE intBusinessUnitId = @bu AND isActive = 1
      GROUP BY FORMAT(dteTransactionDate,'yyyy-MM')
      ORDER BY period ASC`);

    const statsRows = await run(pool, `
      SELECT AVG(CAST(numAmount AS FLOAT)) AS meanAmt, STDEV(CAST(numAmount AS FLOAT)) AS stdAmt,
        COUNT(*) AS totalCnt, MAX(ABS(numAmount)) AS maxAmt
      FROM fin.tblAccountingJournal WHERE intBusinessUnitId = @bu AND isActive = 1`);
    const stats = statsRows[0] || {};
    const mean = stats.meanAmt || 0;
    const std = stats.stdAmt || 1;

    const outlierRows = await run(pool, `
      SELECT
        SUM(CASE WHEN ABS(CAST(numAmount AS FLOAT) - @mean) > 10 * @std THEN 1 ELSE 0 END) AS beyond10sigma,
        SUM(CASE WHEN ABS(CAST(numAmount AS FLOAT) - @mean) > 20 * @std THEN 1 ELSE 0 END) AS beyond20sigma,
        SUM(CASE WHEN ABS(numAmount) >= 100000 THEN 1 ELSE 0 END) AS totalLarge,
        SUM(CASE WHEN ABS(numAmount) >= 100000 AND CAST(ROUND(ABS(numAmount),0) AS BIGINT) % 100000 = 0 THEN 1 ELSE 0 END) AS round100k,
        SUM(CASE WHEN ABS(numAmount) >= 100000 AND CAST(ROUND(ABS(numAmount),0) AS BIGINT) % 1000000 = 0 THEN 1 ELSE 0 END) AS round1m
      FROM fin.tblAccountingJournal
      WHERE intBusinessUnitId = @bu AND isActive = 1`,
      {
        mean: { type: sql.Float, value: mean },
        std: { type: sql.Float, value: std },
      });

    const budgetHeaderRows = await run(pool, `
      SELECT TOP 1 intBudgetHeaderId AS id, strFiscalYear AS fiscalYear, strBudgetCode AS code, dteActionDateTime AS actionDateTime
      FROM bgt.tblBudgetIncomeExpenseHeader
      WHERE intBusinessUnitId = @bu AND isActive = 1
      ORDER BY dteActionDateTime DESC`);
    const budgetHeader = budgetHeaderRows[0] || null;

    let budgetMonthly = [];
    let financialExpenseBreakdown = null;
    if (budgetHeader) {
      const rawBudgetRows = await run(pool, `
        SELECT r.intMonthId AS month, gl.strGeneralLedgerName AS gl, r.intSubGlId AS subGlId, r.numAmount AS amount
        FROM bgt.tblBudgetIncomeExpenseRow r
        JOIN fin.tblGeneralLedger gl ON gl.intGeneralLedgerId = r.intGeneralLedgerId
        WHERE r.intBudgetHeaderId = @budgetHeaderId`,
        { budgetHeaderId: { type: sql.BigInt, value: budgetHeader.id } });
      const aggregated = aggregateBudgetMonthly(rawBudgetRows);
      budgetMonthly = aggregated.monthly;
      financialExpenseBreakdown = aggregated.financialExpenseBreakdown;
    }

    const budgetBsRows = await run(pool, `SELECT COUNT(*) AS cnt FROM bgt.tblBudgetBalanceSheetHeader WHERE intBusinessUnitId = @bu`);
    const budgetTbRows = await run(pool, `SELECT COUNT(*) AS cnt FROM bgt.tblBudgetTrialBalance WHERE intBusinessUnitId = @bu`);
    const projCashFlowRows = await run(pool, `
      SELECT COUNT(*) AS cnt, MIN(dteDate) AS minDate, MAX(dteDate) AS maxDate
      FROM fin.tblProjectedCashFlowDailyHistory WHERE intUnitId = @bu`);

    res.status(200).json({
      meta: {
        businessUnitId: BU_ID,
        businessUnitName: 'Akij Air Service Ltd.',
        generatedAt: new Date().toISOString(),
      },
      budget: {
        header: budgetHeader,
        monthly: budgetMonthly,
        financialExpenseBreakdown,
        balanceSheetBudgetRows: (budgetBsRows[0] || {}).cnt || 0,
        trialBalanceBudgetRows: (budgetTbRows[0] || {}).cnt || 0,
        projectedCashFlow: projCashFlowRows[0] || { cnt: 0, minDate: null, maxDate: null },
      },
      monthly,
      balanceSheet,
      bank,
      assets,
      assetAnalysis: {
        categories: assetCategories,
        acBatch,
        vehicleMonthlyDep,
      },
      segments,
      vendors,
      governance: { twoFactor, auditByMonth },
      employeeCount: (employeeCountRows[0] || {}).employeeCount || 0,
      taxLines,
      relatedParty,
      outliers: {
        mean,
        std,
        totalTransactions: stats.totalCnt || 0,
        maxAmount: stats.maxAmt || 0,
        beyond10sigma: (outlierRows[0] || {}).beyond10sigma || 0,
        beyond20sigma: (outlierRows[0] || {}).beyond20sigma || 0,
        totalLarge: (outlierRows[0] || {}).totalLarge || 0,
        round100k: (outlierRows[0] || {}).round100k || 0,
        round1m: (outlierRows[0] || {}).round1m || 0,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
