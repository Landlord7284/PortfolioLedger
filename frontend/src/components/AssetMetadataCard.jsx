import { useEffect, useState } from 'react';
import { Edit2, Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command';
import { formatCnpj, normalizeCnpj } from '@/lib/formatters';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

const AUTO_VALUE = '__auto__';
const BRAZILIAN_CLASSIFICATION_FIELDS = ['sector', 'subsector', 'segment'];
const GICS_FIELDS = ['gics_sector', 'gics_industry_group', 'gics_industry', 'gics_sub_industry'];
const OPTIONAL_METADATA_FIELDS = new Set([...GICS_FIELDS, 'reit_type']);
const AUTOCOMPLETE_METADATA_FIELDS = new Set([...BRAZILIAN_CLASSIFICATION_FIELDS, ...GICS_FIELDS]);

const FISCAL_REGIME_OPTIONS = [
  { value: 'B3_COMMON_15', label: 'B3 - Operacoes comuns 15%' },
  { value: 'B3_FII_FIAGRO_20', label: 'B3 - FII / Fiagro 20%' },
  { value: 'FI_INFRA_EXEMPT', label: 'FI-Infra / Isentos' },
  { value: 'CRYPTO_GCAP', label: 'Criptoativos' },
];

const FISCAL_TREATMENT_OPTIONS = [
  { value: 'EXEMPT_ZERO', label: 'Isento sem DARF' },
];

const REIT_TYPE_OPTIONS = [
  { value: 'Equity', label: 'Equity' },
  { value: 'Mortgage', label: 'Mortgage' },
  { value: 'Hybrid', label: 'Hybrid' },
];

const TREASURY_INDEXER_OPTIONS = [
  { value: 'SELIC', label: 'SELIC' },
  { value: 'IPCA', label: 'IPCA' },
  { value: 'PREFIXED', label: 'Prefixado' },
];

const ASSET_METADATA_FIELDS = {
  'Ação': ['name', 'cnpj', 'sector', 'subsector', 'segment'],
  BDR: ['name', 'cnpj', 'sector', 'subsector', 'segment'],
  FII: ['name', 'cnpj', 'segment'],
  'FI-INFRA': ['name', 'cnpj', 'segment'],
  ETF: ['name', 'cnpj', 'isin'],
  Debênture: ['name', 'isin', 'maturity_date'],
  CRI: ['name', 'isin', 'maturity_date'],
  CRA: ['name', 'isin', 'maturity_date'],
  'Tesouro Direto': ['name', 'treasury_indexer', 'maturity_date'],
  Stock: ['name', 'isin', 'gics_sector', 'gics_industry_group', 'gics_industry', 'gics_sub_industry'],
  REIT: ['name', 'isin', 'reit_type', 'gics_sector', 'gics_industry_group', 'gics_industry', 'gics_sub_industry'],
};

const FIELD_LABELS = {
  name: 'Nome da Empresa/Emissor',
  cnpj: 'CNPJ',
  isin: 'Código ISIN',
  sector: 'Setor',
  subsector: 'Subsetor',
  segment: 'Segmento',
  gics_sector: 'Sector',
  gics_industry_group: 'Industry Group',
  gics_industry: 'Industry',
  gics_sub_industry: 'Sub-Industry',
  reit_type: 'REIT Type',
  treasury_indexer: 'Indexador',
  maturity_date: 'Vencimento',
  fiscal_regime_override: 'Regime fiscal',
  fiscal_tax_treatment: 'Tratamento fiscal',
};

function getNameLabel(assetClass) {
  if (['FII', 'FI-INFRA', 'ETF'].includes(assetClass)) return 'Nome do Fundo';
  if (assetClass === 'Tesouro Direto') return 'Nome do Título';
  return FIELD_LABELS.name;
}

function getMetadataFields(assetClass) {
  const fieldNames = ASSET_METADATA_FIELDS[assetClass] || ['name'];
  return fieldNames.map((name) => ({
    name,
    label: name === 'name' ? getNameLabel(assetClass) : FIELD_LABELS[name],
    type: name === 'maturity_date' ? 'date' : name === 'reit_type' || name === 'treasury_indexer' ? 'select' : 'text',
    options: name === 'reit_type' ? REIT_TYPE_OPTIONS : name === 'treasury_indexer' ? TREASURY_INDEXER_OPTIONS : undefined,
    placeholder: name === 'reit_type' ? 'Nao informado' : name === 'treasury_indexer' ? 'Indexador' : undefined,
    required: name === 'treasury_indexer' ? false : !OPTIONAL_METADATA_FIELDS.has(name),
  }));
}

function getEditableFields(assetClass) {
  return [
    ...getMetadataFields(assetClass),
    {
      name: 'fiscal_regime_override',
      label: FIELD_LABELS.fiscal_regime_override,
      type: 'select',
      options: FISCAL_REGIME_OPTIONS,
      placeholder: 'Automatico',
    },
    {
      name: 'fiscal_tax_treatment',
      label: FIELD_LABELS.fiscal_tax_treatment,
      type: 'select',
      options: FISCAL_TREATMENT_OPTIONS,
      placeholder: 'Automatico',
    },
  ];
}

function getUniqueFieldValues(assets, fieldName) {
  const seen = new Set();
  return (assets || [])
    .map((item) => String(item?.[fieldName] || '').trim())
    .filter((value) => {
      if (!value) return false;
      const key = value.toLocaleLowerCase('pt-BR');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }));
}

export function buildAssetMetadataSuggestions(assets = []) {
  return Object.fromEntries(
    [...BRAZILIAN_CLASSIFICATION_FIELDS, ...GICS_FIELDS].map((fieldName) => [fieldName, getUniqueFieldValues(assets, fieldName)])
  );
}

function MetadataAutocompleteInput({ name, value, suggestions = [], onValueChange }) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const normalizedValue = String(value || '').trim().toLocaleLowerCase('pt-BR');
  const filteredSuggestions = suggestions
    .filter((option) => {
      const normalizedOption = option.toLocaleLowerCase('pt-BR');
      return normalizedOption !== normalizedValue && normalizedOption.includes(normalizedValue);
    })
    .slice(0, 8);
  const showSuggestions = open && filteredSuggestions.length > 0;
  const activeSuggestion = filteredSuggestions[activeIndex] || filteredSuggestions[0];

  useEffect(() => {
    setActiveIndex(0);
  }, [normalizedValue, suggestions]);

  const applySuggestion = (suggestion) => {
    if (!suggestion) return;
    onValueChange(name, suggestion);
    setOpen(false);
  };

  const handleKeyDown = (event) => {
    if (event.key === 'ArrowDown') {
      if (filteredSuggestions.length === 0) return;
      event.preventDefault();
      if (!showSuggestions) {
        setOpen(true);
        setActiveIndex(0);
        return;
      }
      setActiveIndex((current) => (current + 1) % filteredSuggestions.length);
      return;
    }

    if (event.key === 'ArrowUp') {
      if (filteredSuggestions.length === 0) return;
      event.preventDefault();
      if (!showSuggestions) {
        setOpen(true);
        setActiveIndex(filteredSuggestions.length - 1);
        return;
      }
      setActiveIndex((current) => (current - 1 + filteredSuggestions.length) % filteredSuggestions.length);
      return;
    }

    if (event.key === 'Enter' && showSuggestions) {
      event.preventDefault();
      applySuggestion(activeSuggestion);
      return;
    }

    if (event.key === 'Tab' && showSuggestions) {
      applySuggestion(activeSuggestion);
      return;
    }

    if (event.key === 'Escape' && showSuggestions) {
      event.preventDefault();
      setOpen(false);
    }
  };

  return (
    <Popover open={showSuggestions} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <Input
          className="h-9 text-sm"
          name={name}
          value={value}
          onChange={(event) => {
            onValueChange(name, event.target.value);
            setOpen(true);
          }}
          onClick={() => setOpen(true)}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          autoComplete="off"
          role="combobox"
          aria-expanded={showSuggestions}
        />
      </PopoverAnchor>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] min-w-[220px] p-0"
        align="start"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <Command shouldFilter={false}>
          <CommandList className="max-h-52 overflow-y-auto">
            <CommandGroup>
              {filteredSuggestions.map((option, index) => (
                <CommandItem
                  key={option}
                  value={option}
                  className={cn(index === activeIndex && 'bg-accent text-accent-foreground')}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveIndex(index)}
                  onSelect={() => {
                    applySuggestion(option);
                  }}
                >
                  {option}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function getMissingAssetMetadata(asset) {
  if (!asset) return [];
  return getMetadataFields(asset.asset_class).filter((field) => {
    if (field.required === false) return false;
    const value = asset[field.name];
    return value === null || value === undefined || String(value).trim() === '';
  });
}

export default function AssetMetadataCard({ asset, onSave, metadataSuggestions = {} }) {
  const [editing, setEditing] = useState(false);
  const [formData, setFormData] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    if (asset) {
      setFormData({
        name: asset.name || '',
        cnpj: formatCnpj(asset.cnpj),
        isin: asset.isin || '',
        sector: asset.sector || '',
        subsector: asset.subsector || '',
        segment: asset.segment || '',
        gics_sector: asset.gics_sector || '',
        gics_industry_group: asset.gics_industry_group || '',
        gics_industry: asset.gics_industry || '',
        gics_sub_industry: asset.gics_sub_industry || '',
        reit_type: asset.reit_type || '',
        treasury_indexer: asset.treasury_indexer || '',
        maturity_date: asset.maturity_date || '',
        fiscal_regime_override: asset.fiscal_regime_override || '',
        fiscal_tax_treatment: asset.fiscal_tax_treatment || '',
      });
      setSaveError('');
    }
  }, [asset]);

  if (!asset) return null;

  const fields = getEditableFields(asset.asset_class);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData({ ...formData, [name]: name === 'cnpj' ? formatCnpj(value) : value });
  };

  const handleTextChange = (name, value) => {
    setFormData({ ...formData, [name]: value });
  };

  const handleDateChange = (val) => {
    setFormData({ ...formData, maturity_date: val });
  };

  const handleSelectChange = (name, value) => {
    setFormData({ ...formData, [name]: value === AUTO_VALUE ? '' : value });
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError('');
    try {
      const payload = { ...formData, cnpj: normalizeCnpj(formData.cnpj) };
      if (payload.cnpj && payload.cnpj.length !== 14) {
        throw new Error('CNPJ deve ter 14 dígitos.');
      }
      await onSave(payload);
      setEditing(false);
      toast.success('Informações cadastrais atualizadas.');
    } catch (err) {
      setSaveError(err.message);
      toast.error(err.message || 'Falha ao salvar informações cadastrais.');
    } finally {
      setSaving(false);
    }
  };

  const formatDisplayDate = (isoStr) => {
    if (!isoStr) return '—';
    const [y, m, d] = isoStr.split('-');
    return `${d}/${m}/${y}`;
  };

  const displayValue = (field) => {
    if (field.name === 'maturity_date' && asset[field.name]) {
      return formatDisplayDate(asset[field.name]);
    }
    if (field.type === 'select') {
      if (!asset[field.name] && field.name === 'treasury_indexer') return '—';
      return field.options.find((option) => option.value === asset[field.name])?.label || field.placeholder;
    }
    if (field.name === 'cnpj') {
      return formatCnpj(asset[field.name]) || '—';
    }
    return asset[field.name] || '—';
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between border-b">
        <CardTitle className="text-base">Informações Cadastrais</CardTitle>
        {!editing ? (
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Edit2 data-icon="inline-start" /> Editar
          </Button>
        ) : (
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => { setEditing(false); setSaveError(''); }}>Cancelar</Button>
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? <Loader2 data-icon="inline-start" className="animate-spin" /> : 'Salvar'}
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="pt-4">
        {saveError && (
          <Alert variant="destructive" className="mb-4">
            <AlertDescription>{saveError}</AlertDescription>
          </Alert>
        )}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
          {fields.map((field) => (
            <div className="flex flex-col gap-1.5" key={field.name}>
              <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{field.label}</Label>
              {editing ? (
                field.type === 'date' ? (
                  <DatePicker value={formData[field.name]} onChange={handleDateChange} />
                ) : field.type === 'select' ? (
                  <Select
                    value={formData[field.name] || AUTO_VALUE}
                    onValueChange={(value) => handleSelectChange(field.name, value)}
                  >
                    <SelectTrigger className="h-9 w-full text-sm">
                      <SelectValue placeholder={field.placeholder} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value={AUTO_VALUE}>{field.placeholder}</SelectItem>
                        {field.options.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                ) : AUTOCOMPLETE_METADATA_FIELDS.has(field.name) ? (
                  <MetadataAutocompleteInput
                    name={field.name}
                    value={formData[field.name]}
                    suggestions={metadataSuggestions[field.name] || []}
                    onValueChange={handleTextChange}
                  />
                ) : (
                  <Input
                    className="h-9 text-sm"
                    name={field.name}
                    value={formData[field.name]}
                    onChange={handleChange}
                    inputMode={field.name === 'cnpj' ? 'numeric' : undefined}
                    maxLength={field.name === 'cnpj' ? 18 : undefined}
                  />
                )
              ) : (
                <div className="flex h-9 items-center py-1 text-sm font-medium">
                  {displayValue(field)}
                </div>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
