import { useState } from "react";
import { Plus, Table2, Trash2 } from "lucide-react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  Facts,
  FormFooter,
  InlineView,
  Segmented,
  TextAreaField,
  TextField,
} from "@termix-ssh/plugin-sdk/ui";
import type { ColumnInfo, RowValues } from "../shared/types";

interface Cell {
  text: string;
  isNull: boolean;
  touched: boolean;
}

interface ExtraField {
  name: string;
  text: string;
  isNull: boolean;
}

/**
 * Adds a row or edits one. For an edit only the changed values are sent, and
 * the old key values find the row. Supports dynamic schema & JSON document view.
 */
export function RowEditor({
  columns,
  row,
  canWrite,
  saving,
  error: externalError,
  onClose,
  onSave,
  onDelete,
}: {
  columns: ColumnInfo[];
  /** The row being edited, or null for a new row. */
  row: Array<string | null> | null;
  canWrite: boolean;
  saving: boolean;
  error: string;
  onClose: () => void;
  onSave: (values: RowValues, key: RowValues) => void;
  onDelete?: (key: RowValues) => void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"fields" | "json">("fields");
  const [jsonError, setJsonError] = useState("");
  const [newFieldName, setNewFieldName] = useState("");
  const [extraFields, setExtraFields] = useState<ExtraField[]>([]);

  const [jsonText, setJsonText] = useState(() => {
    const doc: Record<string, unknown> = {};
    columns.forEach((col, idx) => {
      const val = row ? row[idx] : null;
      if (val !== null && val !== undefined) {
        try {
          doc[col.name] = JSON.parse(val);
        } catch {
          doc[col.name] = val;
        }
      }
    });
    return JSON.stringify(doc, null, 2);
  });

  const [cells, setCells] = useState<Record<string, Cell>>(() => {
    const out: Record<string, Cell> = {};
    columns.forEach((column, index) => {
      const value = row ? (row[index] ?? null) : null;
      out[column.name] = {
        text: value ?? "",
        isNull: row ? value === null : false,
        touched: false,
      };
    });
    return out;
  });

  const patch = (name: string, change: Partial<Cell>) =>
    setCells((current) => ({
      ...current,
      [name]: { ...current[name], ...change, touched: true },
    }));

  const key = (): RowValues => {
    const out: RowValues = {};
    columns.forEach((column, index) => {
      if (column.primary && row) out[column.name] = row[index] ?? null;
    });
    return out;
  };

  const addField = () => {
    const trimmed = newFieldName.trim();
    if (!trimmed) return;
    if (cells[trimmed] || extraFields.some((f) => f.name === trimmed)) return;
    setExtraFields((current) => [
      ...current,
      { name: trimmed, text: "", isNull: false },
    ]);
    setNewFieldName("");
  };

  const patchExtra = (index: number, change: Partial<ExtraField>) => {
    setExtraFields((current) =>
      current.map((f, i) => (i === index ? { ...f, ...change } : f)),
    );
  };

  const removeExtra = (index: number) => {
    setExtraFields((current) => current.filter((_, i) => i !== index));
  };

  const save = () => {
    setJsonError("");
    if (mode === "json") {
      try {
        const parsed = JSON.parse(jsonText);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          setJsonError(
            t("row.jsonMustBeObject", {
              defaultValue: "JSON must be an object",
            }),
          );
          return;
        }
        const values: RowValues = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (k === "_id" && row) continue;
          values[k] =
            v === null
              ? null
              : typeof v === "object"
                ? JSON.stringify(v)
                : String(v);
        }
        onSave(values, key());
      } catch (e) {
        setJsonError(e instanceof Error ? e.message : "Invalid JSON");
      }
      return;
    }

    const values: RowValues = {};
    for (const column of columns) {
      const cell = cells[column.name];
      if (!column.editable || !cell.touched) continue;
      values[column.name] = cell.isNull ? null : cell.text;
    }
    for (const extra of extraFields) {
      if (!extra.name.trim()) continue;
      values[extra.name.trim()] = extra.isNull ? null : extra.text;
    }
    onSave(values, key());
  };

  const locked = columns.filter((column) => !column.editable);
  const error = externalError || jsonError;

  return (
    <InlineView
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={row ? t("row.editTitle") : t("row.addTitle")}
      icon={<Table2 className="size-4" />}
      footer={
        <FormFooter
          onCancel={onClose}
          onSave={save}
          saving={saving}
          disabled={!canWrite}
          cancelLabel={t("common.cancel")}
          saveLabel={t("common.save")}
          onDelete={row && onDelete ? () => onDelete(key()) : undefined}
          deleteLabel={t("common.delete")}
        />
      }
    >
      <div className="flex flex-col gap-3 p-3">
        {!canWrite && (
          <p className="text-xs text-muted-foreground">{t("data.readOnly")}</p>
        )}
        <div className="flex items-center justify-between">
          <Segmented<"fields" | "json">
            value={mode}
            onChange={setMode}
            options={[
              {
                value: "fields",
                label: t("row.modeForm", { defaultValue: "Fields" }),
              },
              {
                value: "json",
                label: t("row.modeJson", { defaultValue: "JSON Document" }),
              },
            ]}
          />
        </div>

        {mode === "json" ? (
          <div className="flex flex-col gap-2">
            <TextAreaField
              label={t("row.jsonLabel", { defaultValue: "Document JSON" })}
              value={jsonText}
              onChange={setJsonText}
              rows={14}
              mono
              disabled={!canWrite}
            />
          </div>
        ) : (
          <>
            {columns
              .filter((column) => column.editable)
              .map((column) => {
                const cell = cells[column.name];
                return (
                  <TextAreaField
                    key={column.name}
                    label={`${column.name}  ${column.type}${column.primary ? "  PK" : ""}`}
                    value={cell.isNull ? "" : cell.text}
                    onChange={(text) =>
                      patch(column.name, { text, isNull: false })
                    }
                    placeholder={
                      cell.isNull
                        ? "NULL"
                        : column.default !== null
                          ? t("row.defaultHint", { value: column.default })
                          : ""
                    }
                    rows={
                      cell.text.length > 80 || cell.text.includes("\n") ? 4 : 1
                    }
                    mono
                    disabled={!canWrite}
                    aside={
                      column.nullable ? (
                        <Button
                          variant="ghost"
                          size="xs"
                          disabled={!canWrite}
                          onClick={() =>
                            patch(column.name, {
                              isNull: !cell.isNull,
                              text: "",
                            })
                          }
                        >
                          {cell.isNull ? t("row.setValue") : t("row.setNull")}
                        </Button>
                      ) : undefined
                    }
                  />
                );
              })}

            {extraFields.map((field, idx) => (
              <div
                key={idx}
                className="flex flex-col gap-1 rounded border border-dashed border-border p-2"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold">{field.name}</span>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() =>
                        patchExtra(idx, { isNull: !field.isNull, text: "" })
                      }
                    >
                      {field.isNull ? t("row.setValue") : t("row.setNull")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => removeExtra(idx)}
                    >
                      <Trash2 className="size-3.5 text-destructive" />
                    </Button>
                  </div>
                </div>
                <TextAreaField
                  label=""
                  value={field.isNull ? "" : field.text}
                  onChange={(text) => patchExtra(idx, { text, isNull: false })}
                  placeholder={field.isNull ? "NULL" : ""}
                  rows={
                    field.text.length > 80 || field.text.includes("\n") ? 3 : 1
                  }
                  mono
                  disabled={!canWrite}
                />
              </div>
            ))}

            {canWrite && (
              <div className="flex items-center gap-2 pt-1">
                <TextField
                  label=""
                  placeholder={t("row.newFieldPlaceholder", {
                    defaultValue: "New field name...",
                  })}
                  value={newFieldName}
                  onChange={setNewFieldName}
                  mono
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={addField}
                  disabled={!newFieldName.trim()}
                >
                  <Plus className="mr-1 size-3.5" />
                  {t("row.addField", { defaultValue: "Add Field" })}
                </Button>
              </div>
            )}
          </>
        )}

        {locked.length > 0 && (
          <div className="flex flex-col gap-1 border border-border p-3 text-xs">
            <p>{t("row.locked")}</p>
            <Facts>
              {locked.map((column) => (
                <span key={column.name} className="font-mono">
                  {column.name}
                </span>
              ))}
            </Facts>
          </div>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    </InlineView>
  );
}
