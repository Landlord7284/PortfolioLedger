import { useEffect, useState } from 'react';
import { reports as reportsApi } from '../api/client';

const currentYear = new Date().getFullYear();
const fallbackYears = [String(currentYear)];

export function useReportYearOptions(activePortfolioId, year, setYear) {
  const [yearOptions, setYearOptions] = useState(fallbackYears);

  useEffect(() => {
    if (!activePortfolioId) {
      setYearOptions(fallbackYears);
      return;
    }

    let active = true;
    async function loadYearOptions() {
      try {
        const data = await reportsApi.yearOptions({ portfolioId: activePortfolioId });
        if (!active) return;
        const years = Array.isArray(data?.years) && data.years.length > 0
          ? data.years.map((option) => String(option))
          : fallbackYears;
        setYearOptions(years);
      } catch {
        if (active) setYearOptions(fallbackYears);
      }
    }

    loadYearOptions();
    return () => {
      active = false;
    };
  }, [activePortfolioId]);

  useEffect(() => {
    if (yearOptions.length > 0 && !yearOptions.includes(year)) {
      setYear(yearOptions[0]);
    }
  }, [setYear, year, yearOptions]);

  return yearOptions;
}
