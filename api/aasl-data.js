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

    const segments = await run(pool, `
      SELECT COALESCE(NULLIF(strCostRevenueName,''),'(Unassigned)') AS segment,
        SUM(CASE WHEN strGeneralLedgerName LIKE '%Sales%' OR strGeneralLedgerName LIKE '%Income%' OR strGeneralLedgerName LIKE '%Royalty%' THEN numAmount ELSE 0 END) AS revenue,
        SUM(CASE WHEN strGeneralLedgerName NOT LIKE '%Sales%' AND strGeneralLedgerName NOT LIKE '%Income%' AND strGeneralLedgerName NOT LIKE '%Royalty%' AND numAmount > 0 THEN numAmount ELSE 0 END) AS expense
      FROM fin.tblAccountingJournal
      WHERE intBusinessUnitId = @bu AND isActive = 1 AND dteTransactionDate >= DATEADD(year,-1,GETDATE())
      GROUP BY COALESCE(NULLIF(strCostRevenueName,''),'(Unassigned)')
      ORDER BY 2 + 3 DESC`);

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

    res.status(200).json({
      meta: {
        businessUnitId: BU_ID,
        businessUnitName: 'Akij Air Service Ltd.',
        generatedAt: new Date().toISOString(),
      },
      monthly,
      balanceSheet,
      bank,
      assets,
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
