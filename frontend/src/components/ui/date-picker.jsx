import * as React from "react"
import { format } from "date-fns"
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

export function DatePicker({ value, onChange, disabled }) {
  const date = value ? new Date(`${value}T12:00:00`) : undefined;
  const formattedValue = formatInputValue(value);
  const [inputValue, setInputValue] = React.useState(formattedValue);
  const [isEditing, setIsEditing] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const displayedValue = isEditing ? inputValue : formattedValue;

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
      <Popover open={open} onOpenChange={setOpen}>
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
            onSelect={(d) => {
              if (d) {
                const nextValue = format(d, "yyyy-MM-dd");
                setInputValue(format(d, "dd/MM/yyyy"));
                onChange(nextValue);
                setOpen(false);
              } else {
                setInputValue("");
                onChange("");
              }
            }}
            initialFocus
          />
        </PopoverContent>
      </Popover>
    </div>
  )
}
