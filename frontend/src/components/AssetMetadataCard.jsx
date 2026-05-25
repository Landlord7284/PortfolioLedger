import { useEffect, useState } from 'react';
import { Edit2, Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';

const AUTO_VALUE = '__auto__';

const FISCAL_REGIME_OPTIONS = [
  { value: 'B3_COMMON_15', label: 'B3 - Operacoes comuns 15%' },
  { value: 'B3_FII_FIAGRO_20', label: 'B3 - FII / Fiagro 20%' },
  { value: 'FI_INFRA_EXEMPT', label: 'FI-Infra / Isentos' },
  { value: 'CRYPTO_GCAP', label: 'Criptoativos' },
];

const FISCAL_TREATMENT_OPTIONS = [
  { value: 'EXEMPT_ZERO', label: 'Isento sem DARF' },
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
  'Tesouro Direto': ['name', 'maturity_date'],
  Stock: ['name', 'isin'],
  REIT: ['name', 'isin'],
};

const FIELD_LABELS = {
  name: 'Nome da Empresa/Emissor',
  cnpj: 'CNPJ',
  isin: 'Código ISIN',
  sector: 'Setor',
  subsector: 'Subsetor',
  segment: 'Segmento',
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
    type: name === 'maturity_date' ? 'date' : 'text',
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

export function getMissingAssetMetadata(asset) {
  if (!asset) return [];
  return getMetadataFields(asset.asset_class).filter((field) => {
    const value = asset[field.name];
    return value === null || value === undefined || String(value).trim() === '';
  });
}

export default function AssetMetadataCard({ asset, onSave }) {
  const [editing, setEditing] = useState(false);
  const [formData, setFormData] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    if (asset) {
      setFormData({
        name: asset.name || '',
        cnpj: asset.cnpj || '',
        isin: asset.isin || '',
        sector: asset.sector || '',
        subsector: asset.subsector || '',
        segment: asset.segment || '',
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
      await onSave({ ...formData });
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
      return field.options.find((option) => option.value === asset[field.name])?.label || field.placeholder;
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
                ) : (
                  <Input
                    className="h-9 text-sm"
                    name={field.name}
                    value={formData[field.name]}
                    onChange={handleChange}
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
