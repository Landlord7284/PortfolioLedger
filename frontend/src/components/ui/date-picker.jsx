import * as React from "react"
import { addDays, format } from "date-fns"
import { Calendar as CalendarIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

function formatInputValue(value) {
  if (!value) return "";
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return "";
  return format(date, "dd/MM/yyyy");
}

function maskDateInput(value) {
  const digits = value.replace(/\D/g, "").slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}

function parseInputDate(value) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(year, month - 1, day, 12, 0, 0);

  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }

  return date;
}

export function DatePicker({ value, onChange, disabled, presets = [] }) {
  const date = value ? new Date(`${value}T12:00:00`) : undefined;
  const formattedValue = formatInputValue(value);
  const [inputValue, setInputValue] = React.useState(formattedValue);
  const [isEditing, setIsEditing] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [currentMonth, setCurrentMonth] = React.useState(() => date || new Date());
  const displayedValue = isEditing ? inputValue : formattedValue;

  const selectDate = (nextDate) => {
    const nextValue = format(nextDate, "yyyy-MM-dd");
    setInputValue(format(nextDate, "dd/MM/yyyy"));
    setCurrentMonth(new Date(nextDate.getFullYear(), nextDate.getMonth(), 1));
    onChange(nextValue);
    setOpen(false);
  };

  const handleOpenChange = (nextOpen) => {
    if (nextOpen) {
      setCurrentMonth(date || new Date());
    }
    setOpen(nextOpen);
  };

  const handleInputChange = (event) => {
    const nextValue = maskDateInput(event.target.value);
    setInputValue(nextValue);

    if (!nextValue) {
      onChange("");
      return;
    }

    if (nextValue.length === 10) {
      const parsedDate = parseInputDate(nextValue);
      if (parsedDate) {
        setCurrentMonth(new Date(parsedDate.getFullYear(), parsedDate.getMonth(), 1));
        onChange(format(parsedDate, "yyyy-MM-dd"));
      }
    }
  };

  const handleInputFocus = () => {
    setInputValue(formattedValue);
    setIsEditing(true);
  };

  const handleInputBlur = () => {
    setIsEditing(false);
  };
  
  return (
    <div className="relative flex w-full items-center">
      <Input
        value={displayedValue}
        onChange={handleInputChange}
        onFocus={handleInputFocus}
        onBlur={handleInputBlur}
        disabled={disabled}
        placeholder="DD/MM/YYYY"
        inputMode="numeric"
        maxLength={10}
        className="h-9 pr-9 bg-transparent"
      />
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={disabled}
            className={cn(
              "absolute right-0 h-9 w-9 text-muted-foreground hover:text-foreground",
              !date && "text-muted-foreground"
            )}
            aria-label="Selecionar data"
          >
            <CalendarIcon className="h-4 w-4 shrink-0 opacity-70" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={date}
            month={currentMonth}
            onMonthChange={setCurrentMonth}
            onSelect={(d) => {
              if (d) {
                selectDate(d);
              } else {
                setInputValue("");
                onChange("");
              }
            }}
            initialFocus
          />
          {presets.length > 0 && (
            <div className="flex flex-wrap gap-2 border-t p-3">
              {presets.map((preset) => (
                <Button
                  key={preset.value}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={() => selectDate(addDays(new Date(), preset.value))}
                >
                  {preset.label}
                </Button>
              ))}
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  )
}
