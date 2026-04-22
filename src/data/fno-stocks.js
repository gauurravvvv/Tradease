/**
 * Top 50 most liquid F&O stocks on NSE.
 * Lot sizes as of 2025. Includes NIFTY and BANKNIFTY indices.
 */
export const FNO_STOCKS = [
  // Indices
  { symbol: 'NIFTY',       name: 'Nifty 50',                   lotSize: 25,   sector: 'Index' },
  { symbol: 'BANKNIFTY',   name: 'Bank Nifty',                 lotSize: 15,   sector: 'Index' },

  // Banking & Finance
  { symbol: 'HDFCBANK',    name: 'HDFC Bank',                  lotSize: 550,  sector: 'Banking' },
  { symbol: 'ICICIBANK',   name: 'ICICI Bank',                 lotSize: 700,  sector: 'Banking' },
  { symbol: 'SBIN',        name: 'State Bank of India',        lotSize: 750,  sector: 'Banking' },
  { symbol: 'KOTAKBANK',   name: 'Kotak Mahindra Bank',        lotSize: 400,  sector: 'Banking' },
  { symbol: 'AXISBANK',    name: 'Axis Bank',                  lotSize: 625,  sector: 'Banking' },
  { symbol: 'INDUSINDBK',  name: 'IndusInd Bank',              lotSize: 500,  sector: 'Banking' },
  { symbol: 'BANKBARODA',  name: 'Bank of Baroda',             lotSize: 2925, sector: 'Banking' },
  { symbol: 'PNB',         name: 'Punjab National Bank',       lotSize: 4000, sector: 'Banking' },
  { symbol: 'BAJFINANCE',  name: 'Bajaj Finance',              lotSize: 125,  sector: 'Finance' },
  { symbol: 'BAJAJFINSV',  name: 'Bajaj Finserv',              lotSize: 500,  sector: 'Finance' },
  { symbol: 'SBILIFE',     name: 'SBI Life Insurance',         lotSize: 375,  sector: 'Finance' },

  // IT
  { symbol: 'TCS',         name: 'Tata Consultancy Services',  lotSize: 175,  sector: 'IT' },
  { symbol: 'INFY',        name: 'Infosys',                    lotSize: 400,  sector: 'IT' },
  { symbol: 'WIPRO',       name: 'Wipro',                      lotSize: 1500, sector: 'IT' },
  { symbol: 'HCLTECH',     name: 'HCL Technologies',           lotSize: 350,  sector: 'IT' },
  { symbol: 'TECHM',       name: 'Tech Mahindra',              lotSize: 600,  sector: 'IT' },
  { symbol: 'LTIM',        name: 'LTIMindtree',                lotSize: 150,  sector: 'IT' },

  // Energy & Oil
  { symbol: 'RELIANCE',    name: 'Reliance Industries',        lotSize: 250,  sector: 'Energy' },
  { symbol: 'ONGC',        name: 'Oil & Natural Gas Corp',     lotSize: 1925, sector: 'Energy' },
  { symbol: 'BPCL',        name: 'Bharat Petroleum',           lotSize: 1800, sector: 'Energy' },
  { symbol: 'IOC',         name: 'Indian Oil Corporation',     lotSize: 3250, sector: 'Energy' },
  { symbol: 'NTPC',        name: 'NTPC',                       lotSize: 1500, sector: 'Energy' },
  { symbol: 'POWERGRID',   name: 'Power Grid Corporation',     lotSize: 2700, sector: 'Energy' },
  { symbol: 'ADANIENT',    name: 'Adani Enterprises',          lotSize: 250,  sector: 'Energy' },
  { symbol: 'TATAPOWER',   name: 'Tata Power',                 lotSize: 1350, sector: 'Energy' },

  // Auto
  { symbol: 'TATAMOTORS',  name: 'Tata Motors',                lotSize: 575,  sector: 'Auto' },
  { symbol: 'MARUTI',      name: 'Maruti Suzuki',              lotSize: 50,   sector: 'Auto' },
  { symbol: 'M&M',         name: 'Mahindra & Mahindra',        lotSize: 350,  sector: 'Auto' },
  { symbol: 'BAJAJ-AUTO',  name: 'Bajaj Auto',                 lotSize: 75,   sector: 'Auto' },
  { symbol: 'EICHERMOT',   name: 'Eicher Motors',              lotSize: 175,  sector: 'Auto' },
  { symbol: 'HEROMOTOCO',  name: 'Hero MotoCorp',              lotSize: 150,  sector: 'Auto' },

  // Metals & Mining
  { symbol: 'TATASTEEL',   name: 'Tata Steel',                 lotSize: 3375, sector: 'Metals' },
  { symbol: 'JSWSTEEL',    name: 'JSW Steel',                  lotSize: 675,  sector: 'Metals' },
  { symbol: 'HINDALCO',    name: 'Hindalco Industries',        lotSize: 1075, sector: 'Metals' },
  { symbol: 'COALINDIA',   name: 'Coal India',                 lotSize: 1050, sector: 'Metals' },

  // Pharma & Healthcare
  { symbol: 'SUNPHARMA',   name: 'Sun Pharma',                 lotSize: 350,  sector: 'Pharma' },
  { symbol: 'DRREDDY',     name: "Dr Reddy's Laboratories",    lotSize: 125,  sector: 'Pharma' },
  { symbol: 'CIPLA',       name: 'Cipla',                      lotSize: 325,  sector: 'Pharma' },
  { symbol: 'APOLLOHOSP',  name: 'Apollo Hospitals',           lotSize: 125,  sector: 'Healthcare' },

  // FMCG & Consumer
  { symbol: 'HINDUNILVR',  name: 'Hindustan Unilever',         lotSize: 300,  sector: 'FMCG' },
  { symbol: 'ITC',         name: 'ITC',                        lotSize: 1600, sector: 'FMCG' },
  { symbol: 'NESTLEIND',   name: 'Nestle India',               lotSize: 200,  sector: 'FMCG' },
  { symbol: 'TITAN',       name: 'Titan Company',              lotSize: 175,  sector: 'Consumer' },

  // Infra & Cement
  { symbol: 'LT',          name: 'Larsen & Toubro',            lotSize: 225,  sector: 'Infra' },
  { symbol: 'ULTRACEMCO',  name: 'UltraTech Cement',           lotSize: 50,   sector: 'Cement' },
  { symbol: 'GRASIM',      name: 'Grasim Industries',          lotSize: 250,  sector: 'Cement' },

  // Telecom
  { symbol: 'BHARTIARTL',  name: 'Bharti Airtel',              lotSize: 475,  sector: 'Telecom' },

  // Diversified
  { symbol: 'ASIANPAINT',  name: 'Asian Paints',               lotSize: 200,  sector: 'Consumer' },
  { symbol: 'DIVISLAB',    name: "Divi's Laboratories",        lotSize: 125,  sector: 'Pharma' },
];
