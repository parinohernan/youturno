import { useState } from "preact/hooks";
import { useApp } from "../context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { strings } from "@/lib/strings";
import type { Product } from "../types";

function numberOr(value: string, fallback: number): number {
  if (value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function CreateProduct({ onClose, product }: { onClose: () => void; product?: Product }) {
  const { addProduct, updateProduct, setError } = useApp();
  const [name, setName] = useState(product?.name || "");
  const [brand, setBrand] = useState(product?.brand || "");
  const [category, setCategory] = useState(product?.category || "");
  const [sku, setSku] = useState(product?.sku || "");
  const [price, setPrice] = useState(String(product?.price ?? 0));
  const [cost, setCost] = useState(String(product?.cost ?? 0));
  const [stock, setStock] = useState(String(product?.stock ?? 0));
  const [lowStockAlert, setLowStockAlert] = useState(String(product?.low_stock_alert ?? 5));
  const [saving, setSaving] = useState(false);
  const isEditing = product !== undefined;

  const handleSubmit = async () => {
    if (!name.trim()) { setError(strings.nameRequired); return; }
    setSaving(true);
    try {
      const data = {
        name: name.trim(), brand, category, sku,
        price: numberOr(price, 0),
        cost: numberOr(cost, 0),
        stock: Math.trunc(numberOr(stock, 0)),
        low_stock_alert: Math.trunc(numberOr(lowStockAlert, 5)),
      };
      if (product) await updateProduct(product.id, data);
      else await addProduct(data);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Editar producto" : "Agregar producto"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="product-name">Nombre *</Label>
            <Input id="product-name" value={name} onChange={(e) => setName((e.target as HTMLInputElement).value)} placeholder="Nombre del producto" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="product-brand">Marca</Label>
              <Input id="product-brand" value={brand} onChange={(e) => setBrand((e.target as HTMLInputElement).value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="product-category">Categoría</Label>
              <Input id="product-category" value={category} onChange={(e) => setCategory((e.target as HTMLInputElement).value)} placeholder="ej. Cuidado del cabello" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="product-sku">SKU</Label>
            <Input id="product-sku" value={sku} onChange={(e) => setSku((e.target as HTMLInputElement).value)} placeholder="Opcional" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="product-price">Precio de venta ($)</Label>
              <Input id="product-price" type="number" min="0" step="0.01" value={price} onChange={(e) => setPrice((e.target as HTMLInputElement).value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="product-cost">Costo ($)</Label>
              <Input id="product-cost" type="number" min="0" step="0.01" value={cost} onChange={(e) => setCost((e.target as HTMLInputElement).value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="product-stock">Stock</Label>
              <Input id="product-stock" type="number" min="0" step="1" value={stock} onChange={(e) => setStock((e.target as HTMLInputElement).value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="product-low-stock-alert">Alerta de stock bajo</Label>
              <Input id="product-low-stock-alert" type="number" min="0" step="1" value={lowStockAlert} onChange={(e) => setLowStockAlert((e.target as HTMLInputElement).value)} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button disabled={saving} onClick={handleSubmit}>{saving ? strings.saving : isEditing ? strings.saveChanges : "Agregar producto"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
