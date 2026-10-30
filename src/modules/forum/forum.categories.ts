// Todo:
// -> share searchable report categories across accounts
// -> merge duplicate names and keep built-in category keys

// --- Report categories ---
import mongoose, { Schema } from "mongoose";
import { sanitizeTextInput } from "../../utils/sanitize.js";

export type CategoryKind = "ecosystem" | "condition";
export const CATEGORY_DEFAULTS = {
  ecosystem: {gambut:"Gambut",hutan_kota:"Hutan kota",mineral:"Mineral",rumah:"Rumah",permukiman:"Permukiman",hutan:"Hutan",mangrove:"Mangrove",kebun:"Kebun",pertanian:"Lahan pertanian",sungai:"Sungai"},
  condition: {subur:"Subur",perlu_rawat:"Perlu dirawat",kritis:"Kritis",mati:"Mati",habis_terbakar:"Habis Terbakar",dalam_pemulihan:"Sedang dalam Pemulihan",terbakar:"Sedang Terbakar",terendam:"Terendam",rusak:"Rusak"},
};
interface CategoryRecord {kind:CategoryKind;key:string;label:string;normalized:string}
const categorySchema = new Schema<CategoryRecord>({kind:{type:String,enum:["ecosystem","condition"],required:true},key:{type:String,required:true,maxlength:60},label:{type:String,required:true,maxlength:60},normalized:{type:String,required:true,maxlength:60}},{timestamps:true});
categorySchema.index({kind:1,normalized:1},{unique:true});
export const ReportCategoryModel = mongoose.models.ReportCategory ?? mongoose.model<CategoryRecord>("ReportCategory",categorySchema);
const normalize = (value:string) => value.normalize("NFKC").trim().replace(/\s+/g," ").toLocaleLowerCase("id-ID");
const builtin = (kind:CategoryKind,value:string) => Object.entries(CATEGORY_DEFAULTS[kind]).find(([key,label]) => normalize(key)===normalize(value) || normalize(label)===normalize(value));

/** Input: category kind and name. Output: one canonical shared category. */
export async function saveCategory(kind:CategoryKind,value:string) {
  const label = sanitizeTextInput(value).normalize("NFKC").trim().replace(/\s+/g," ");
  if (!label || label.length>60 || /[\p{Cc}\p{Cf}]/u.test(label)) throw new Error("INVALID_CATEGORY");
  const preset = builtin(kind,label);
  if (preset) return {key:preset[0],label:preset[1]};
  const normalized=normalize(label);
  await ReportCategoryModel.init();
  let item;
  try {item=await ReportCategoryModel.findOneAndUpdate({kind,normalized},{$setOnInsert:{kind,normalized,key:label,label}},{upsert:true,new:true,runValidators:true});}
  catch(error) {if((error as {code?:number}).code!==11000)throw error;item=await ReportCategoryModel.findOne({kind,normalized});}
  if(!item)throw new Error("INVALID_CATEGORY");
  return {key:item.key as string,label:item.label as string};
}
export async function hasCategory(kind:CategoryKind,key:string) {
  return !!builtin(kind,key) || !!await ReportCategoryModel.exists({kind,key});
}
export async function listCategories() {
  const custom=await ReportCategoryModel.find().select("kind key label -_id").sort({label:1}).limit(2000).lean();
  return Object.fromEntries((["ecosystem","condition"] as const).map(kind => [kind,[...Object.entries(CATEGORY_DEFAULTS[kind]).map(([key,label])=>({key,label})),...custom.filter(item=>item.kind===kind).map(item=>({key:item.key,label:item.label}))]]));
}
// --- end of Report categories ---
