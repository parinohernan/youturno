import { useState } from "preact/hooks";
import { useApp } from "../context";
import { Plus, Search, Trash2, AlertTriangle, Pencil } from "lucide-preact";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Pagination } from "./pagination";
import { CreateProduct } from "./create-product";
import type { Product } from "../types";

export function ProductList() {
  const { products, productsPag, setProductsPage, productsSearch, setProductsSearch, deleteProduct } = useApp();
  const [showCreate, setShowCreate] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Productos</h1>
        <Button size="sm" className="min-h-11 sm:min-h-0" onClick={() => setShowCreate(true)}>
          <Plus className="mr-1 h-3.5 w-3.5" /> Agregar producto
        </Button>
      </div>

      {showCreate && <CreateProduct onClose={() => setShowCreate(false)} />}
      {editingProduct && <CreateProduct product={editingProduct} onClose={() => setEditingProduct(null)} />}

      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input className="h-11 pl-9 sm:h-9" placeholder="Buscar productos..." value={productsSearch} onInput={(e) => setProductsSearch((e.target as HTMLInputElement).value)} />
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="divide-y lg:hidden">
            {products.length === 0 && (
              <p className="py-8 text-center text-sm text-muted-foreground">No se encontraron productos</p>
            )}
            {products.map((p) => (
              <div key={p.id} className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="break-words font-medium">{p.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {[p.brand, p.category, p.sku && `SKU: ${p.sku}`].filter(Boolean).join(" · ") || "Sin más datos del producto"}
                    </p>
                  </div>
                  {p.stock <= p.low_stock_alert && (
                    <span className="shrink-0 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs text-amber-700">Stock bajo</span>
                  )}
                </div>
                <div className="mt-3 grid grid-cols-3 gap-3 text-sm">
                  <div><p className="text-xs text-muted-foreground">Precio</p><p className="font-medium tabular-nums">${p.price.toFixed(2)}</p></div>
                  <div><p className="text-xs text-muted-foreground">Costo</p><p className="tabular-nums">${p.cost.toFixed(2)}</p></div>
                  <div><p className="text-xs text-muted-foreground">Stock</p><p className="flex items-center gap-1 font-medium tabular-nums">{p.stock <= p.low_stock_alert && <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />}{p.stock}</p></div>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-2">
                  <Button variant="outline" className="min-h-11" onClick={() => setEditingProduct(p)}>
                    <Pencil className="mr-1.5 h-3.5 w-3.5" /> Editar
                  </Button>
                  <Button variant="outline" className="min-h-11 text-destructive hover:text-destructive" onClick={() => deleteProduct(p.id)}>
                    <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Eliminar
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <div className="hidden lg:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Producto</TableHead>
                <TableHead className="w-24">Marca</TableHead>
                <TableHead className="w-24">Categoría</TableHead>
                <TableHead className="w-20 text-right">Precio</TableHead>
                <TableHead className="w-16 text-right">Costo</TableHead>
                <TableHead className="w-20 text-center">Stock</TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.length === 0 && (
                <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">No se encontraron productos</TableCell></TableRow>
              )}
              {products.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <div className="font-medium">{p.name}</div>
                    {p.sku && <div className="text-xs text-muted-foreground">SKU: {p.sku}</div>}
                  </TableCell>
                  <TableCell className="text-sm">{p.brand || "—"}</TableCell>
                  <TableCell>
                    {p.category && <Badge variant="outline" className="text-xs">{p.category}</Badge>}
                  </TableCell>
                  <TableCell className="text-right font-medium">${p.price.toFixed(2)}</TableCell>
                  <TableCell className="text-right text-sm text-muted-foreground">${p.cost.toFixed(2)}</TableCell>
                  <TableCell className="text-center">
                    <span className="flex items-center justify-center gap-1">
                      {p.stock <= p.low_stock_alert && (
                        <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                      )}
                      <span className={p.stock <= p.low_stock_alert ? "font-medium text-amber-600" : ""}>{p.stock}</span>
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                    <Button aria-label={`Editar ${p.name}`} variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" onClick={() => setEditingProduct(p)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button aria-label={`Eliminar ${p.name}`} variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={() => deleteProduct(p.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          </div>
        </CardContent>
      </Card>
      <Pagination pag={productsPag} setPage={setProductsPage} />
    </div>
  );
}
