export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      app_settings: {
        Row: {
          key: string
          updated_at: string
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string
          value: Json
        }
        Update: {
          key?: string
          updated_at?: string
          value?: Json
        }
        Relationships: []
      }
      client_access: {
        Row: {
          client_id: string
          id: string
          notes: string | null
          status: Database["public"]["Enums"]["access_status"]
          system: Database["public"]["Enums"]["access_system"]
          updated_at: string
        }
        Insert: {
          client_id: string
          id?: string
          notes?: string | null
          status?: Database["public"]["Enums"]["access_status"]
          system: Database["public"]["Enums"]["access_system"]
          updated_at?: string
        }
        Update: {
          client_id?: string
          id?: string
          notes?: string | null
          status?: Database["public"]["Enums"]["access_status"]
          system?: Database["public"]["Enums"]["access_system"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_access_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      client_contacts: {
        Row: {
          client_id: string
          email: string | null
          id: string
          is_primary: boolean
          name: string
          phone: string | null
          role: string | null
        }
        Insert: {
          client_id: string
          email?: string | null
          id?: string
          is_primary?: boolean
          name: string
          phone?: string | null
          role?: string | null
        }
        Update: {
          client_id?: string
          email?: string | null
          id?: string
          is_primary?: boolean
          name?: string
          phone?: string | null
          role?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_contacts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      client_pipelines: {
        Row: {
          client_id: string
          completed_at: string | null
          enrolled_at: string
          id: string
          pipeline_id: string
          status: Database["public"]["Enums"]["enrollment_status"]
        }
        Insert: {
          client_id: string
          completed_at?: string | null
          enrolled_at?: string
          id?: string
          pipeline_id: string
          status?: Database["public"]["Enums"]["enrollment_status"]
        }
        Update: {
          client_id?: string
          completed_at?: string | null
          enrolled_at?: string
          id?: string
          pipeline_id?: string
          status?: Database["public"]["Enums"]["enrollment_status"]
        }
        Relationships: [
          {
            foreignKeyName: "client_pipelines_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_pipelines_pipeline_id_fkey"
            columns: ["pipeline_id"]
            isOneToOne: false
            referencedRelation: "pipelines"
            referencedColumns: ["id"]
          },
        ]
      }
      client_stages: {
        Row: {
          client_pipeline_id: string
          completed_at: string | null
          due_date: string | null
          evidence: string | null
          id: string
          next_action: string | null
          notes: string | null
          owner: Database["public"]["Enums"]["owner_type"]
          stage_id: string
          started_at: string | null
          status: Database["public"]["Enums"]["stage_status"]
        }
        Insert: {
          client_pipeline_id: string
          completed_at?: string | null
          due_date?: string | null
          evidence?: string | null
          id?: string
          next_action?: string | null
          notes?: string | null
          owner?: Database["public"]["Enums"]["owner_type"]
          stage_id: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["stage_status"]
        }
        Update: {
          client_pipeline_id?: string
          completed_at?: string | null
          due_date?: string | null
          evidence?: string | null
          id?: string
          next_action?: string | null
          notes?: string | null
          owner?: Database["public"]["Enums"]["owner_type"]
          stage_id?: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["stage_status"]
        }
        Relationships: [
          {
            foreignKeyName: "client_stages_client_pipeline_id_fkey"
            columns: ["client_pipeline_id"]
            isOneToOne: false
            referencedRelation: "client_pipelines"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_stages_stage_id_fkey"
            columns: ["stage_id"]
            isOneToOne: false
            referencedRelation: "stages"
            referencedColumns: ["id"]
          },
        ]
      }
      clients: {
        Row: {
          address_line1: string | null
          city: string | null
          created_at: string
          dba: string | null
          drive_root_url: string | null
          id: string
          industry: string | null
          kickoff_at: string | null
          launched_at: string | null
          name: string
          notes: string | null
          phone: string | null
          renewal_at: string | null
          service_area: string | null
          signed_at: string | null
          state: string | null
          status: Database["public"]["Enums"]["client_status"]
          updated_at: string
          website_url: string | null
          zip: string | null
        }
        Insert: {
          address_line1?: string | null
          city?: string | null
          created_at?: string
          dba?: string | null
          drive_root_url?: string | null
          id?: string
          industry?: string | null
          kickoff_at?: string | null
          launched_at?: string | null
          name: string
          notes?: string | null
          phone?: string | null
          renewal_at?: string | null
          service_area?: string | null
          signed_at?: string | null
          state?: string | null
          status?: Database["public"]["Enums"]["client_status"]
          updated_at?: string
          website_url?: string | null
          zip?: string | null
        }
        Update: {
          address_line1?: string | null
          city?: string | null
          created_at?: string
          dba?: string | null
          drive_root_url?: string | null
          id?: string
          industry?: string | null
          kickoff_at?: string | null
          launched_at?: string | null
          name?: string
          notes?: string | null
          phone?: string | null
          renewal_at?: string | null
          service_area?: string | null
          signed_at?: string | null
          state?: string | null
          status?: Database["public"]["Enums"]["client_status"]
          updated_at?: string
          website_url?: string | null
          zip?: string | null
        }
        Relationships: []
      }
      content_posts: {
        Row: {
          client_id: string
          due_date: string | null
          id: string
          keyword_id: string | null
          notes: string | null
          owner: Database["public"]["Enums"]["owner_type"]
          published_at: string | null
          status: Database["public"]["Enums"]["content_status"]
          title: string
          url: string | null
          word_count: number | null
        }
        Insert: {
          client_id: string
          due_date?: string | null
          id?: string
          keyword_id?: string | null
          notes?: string | null
          owner?: Database["public"]["Enums"]["owner_type"]
          published_at?: string | null
          status?: Database["public"]["Enums"]["content_status"]
          title: string
          url?: string | null
          word_count?: number | null
        }
        Update: {
          client_id?: string
          due_date?: string | null
          id?: string
          keyword_id?: string | null
          notes?: string | null
          owner?: Database["public"]["Enums"]["owner_type"]
          published_at?: string | null
          status?: Database["public"]["Enums"]["content_status"]
          title?: string
          url?: string | null
          word_count?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "content_posts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_posts_keyword_id_fkey"
            columns: ["keyword_id"]
            isOneToOne: false
            referencedRelation: "keywords"
            referencedColumns: ["id"]
          },
        ]
      }
      deliverables: {
        Row: {
          client_id: string
          client_stage_id: string | null
          id: string
          label: string
          monthly_cycle_id: string | null
          type: Database["public"]["Enums"]["deliverable_type"]
          url: string
        }
        Insert: {
          client_id: string
          client_stage_id?: string | null
          id?: string
          label: string
          monthly_cycle_id?: string | null
          type?: Database["public"]["Enums"]["deliverable_type"]
          url: string
        }
        Update: {
          client_id?: string
          client_stage_id?: string | null
          id?: string
          label?: string
          monthly_cycle_id?: string | null
          type?: Database["public"]["Enums"]["deliverable_type"]
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "deliverables_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliverables_client_stage_id_fkey"
            columns: ["client_stage_id"]
            isOneToOne: false
            referencedRelation: "client_stages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliverables_monthly_cycle_id_fkey"
            columns: ["monthly_cycle_id"]
            isOneToOne: false
            referencedRelation: "monthly_cycles"
            referencedColumns: ["id"]
          },
        ]
      }
      documents: {
        Row: {
          category: Database["public"]["Enums"]["document_category"]
          client_id: string
          created_at: string
          file_name: string | null
          id: string
          kind: Database["public"]["Enums"]["document_kind"]
          label: string
          mime_type: string | null
          notes: string | null
          storage_path: string | null
          uploaded_by: string | null
          url: string | null
        }
        Insert: {
          category?: Database["public"]["Enums"]["document_category"]
          client_id: string
          created_at?: string
          file_name?: string | null
          id?: string
          kind: Database["public"]["Enums"]["document_kind"]
          label: string
          mime_type?: string | null
          notes?: string | null
          storage_path?: string | null
          uploaded_by?: string | null
          url?: string | null
        }
        Update: {
          category?: Database["public"]["Enums"]["document_category"]
          client_id?: string
          created_at?: string
          file_name?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["document_kind"]
          label?: string
          mime_type?: string | null
          notes?: string | null
          storage_path?: string | null
          uploaded_by?: string | null
          url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "documents_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      grid_configs: {
        Row: {
          brightlocal_lsg_report_id: string | null
          center_lat: number | null
          center_lng: number | null
          grid_size: number
          id: string
          is_active: boolean
          keyword_ids: string[]
          location_id: string
          spacing_miles: number
        }
        Insert: {
          brightlocal_lsg_report_id?: string | null
          center_lat?: number | null
          center_lng?: number | null
          grid_size?: number
          id?: string
          is_active?: boolean
          keyword_ids?: string[]
          location_id: string
          spacing_miles?: number
        }
        Update: {
          brightlocal_lsg_report_id?: string | null
          center_lat?: number | null
          center_lng?: number | null
          grid_size?: number
          id?: string
          is_active?: boolean
          keyword_ids?: string[]
          location_id?: string
          spacing_miles?: number
        }
        Relationships: [
          {
            foreignKeyName: "grid_configs_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
        ]
      }
      grid_snapshots: {
        Row: {
          avg_map_rank: number | null
          competitors: Json | null
          grid_config_id: string
          id: string
          keyword_id: string
          points: Json | null
          recorded_at: string
          report_url: string | null
          run_id: string | null
          share_of_voice: number | null
        }
        Insert: {
          avg_map_rank?: number | null
          competitors?: Json | null
          grid_config_id: string
          id?: string
          keyword_id: string
          points?: Json | null
          recorded_at?: string
          report_url?: string | null
          run_id?: string | null
          share_of_voice?: number | null
        }
        Update: {
          avg_map_rank?: number | null
          competitors?: Json | null
          grid_config_id?: string
          id?: string
          keyword_id?: string
          points?: Json | null
          recorded_at?: string
          report_url?: string | null
          run_id?: string | null
          share_of_voice?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "grid_snapshots_grid_config_id_fkey"
            columns: ["grid_config_id"]
            isOneToOne: false
            referencedRelation: "grid_configs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grid_snapshots_keyword_id_fkey"
            columns: ["keyword_id"]
            isOneToOne: false
            referencedRelation: "keywords"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grid_snapshots_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "rank_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      gsc_snapshots: {
        Row: {
          avg_position: number | null
          clicks: number
          client_id: string
          ctr: number | null
          id: string
          impressions: number
          keyword_id: string | null
          page: string | null
          period_end: string
          period_start: string
          query: string
          recorded_at: string
        }
        Insert: {
          avg_position?: number | null
          clicks?: number
          client_id: string
          ctr?: number | null
          id?: string
          impressions?: number
          keyword_id?: string | null
          page?: string | null
          period_end: string
          period_start: string
          query: string
          recorded_at?: string
        }
        Update: {
          avg_position?: number | null
          clicks?: number
          client_id?: string
          ctr?: number | null
          id?: string
          impressions?: number
          keyword_id?: string | null
          page?: string | null
          period_end?: string
          period_start?: string
          query?: string
          recorded_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "gsc_snapshots_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gsc_snapshots_keyword_id_fkey"
            columns: ["keyword_id"]
            isOneToOne: false
            referencedRelation: "keywords"
            referencedColumns: ["id"]
          },
        ]
      }
      keywords: {
        Row: {
          client_id: string
          created_at: string
          department: Database["public"]["Enums"]["department"]
          id: string
          is_active: boolean
          keyword: string
          priority: Database["public"]["Enums"]["keyword_priority"]
          target_url: string | null
        }
        Insert: {
          client_id: string
          created_at?: string
          department?: Database["public"]["Enums"]["department"]
          id?: string
          is_active?: boolean
          keyword: string
          priority?: Database["public"]["Enums"]["keyword_priority"]
          target_url?: string | null
        }
        Update: {
          client_id?: string
          created_at?: string
          department?: Database["public"]["Enums"]["department"]
          id?: string
          is_active?: boolean
          keyword?: string
          priority?: Database["public"]["Enums"]["keyword_priority"]
          target_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "keywords_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      location_index: {
        Row: {
          computed_at: string
          id: string
          keywords_counted: number
          location_id: string
          map_index: number | null
          organic_index: number | null
          period: string
        }
        Insert: {
          computed_at?: string
          id?: string
          keywords_counted?: number
          location_id: string
          map_index?: number | null
          organic_index?: number | null
          period: string
        }
        Update: {
          computed_at?: string
          id?: string
          keywords_counted?: number
          location_id?: string
          map_index?: number | null
          organic_index?: number | null
          period?: string
        }
        Relationships: [
          {
            foreignKeyName: "location_index_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
        ]
      }
      locations: {
        Row: {
          brightlocal_location_id: string | null
          brightlocal_lrt_report_id: string | null
          city: string | null
          client_id: string
          gbp_place_id: string | null
          id: string
          is_active: boolean
          is_physical_location: boolean
          lat: number | null
          lng: number | null
          name: string
          sort_order: number
          state: string | null
        }
        Insert: {
          brightlocal_location_id?: string | null
          brightlocal_lrt_report_id?: string | null
          city?: string | null
          client_id: string
          gbp_place_id?: string | null
          id?: string
          is_active?: boolean
          is_physical_location?: boolean
          lat?: number | null
          lng?: number | null
          name: string
          sort_order?: number
          state?: string | null
        }
        Update: {
          brightlocal_location_id?: string | null
          brightlocal_lrt_report_id?: string | null
          city?: string | null
          client_id?: string
          gbp_place_id?: string | null
          id?: string
          is_active?: boolean
          is_physical_location?: boolean
          lat?: number | null
          lng?: number | null
          name?: string
          sort_order?: number
          state?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "locations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      monthly_cycles: {
        Row: {
          client_id: string
          completed_at: string | null
          id: string
          notes: string | null
          period: string
          rank_summary: Json | null
          report_url: string | null
          status: Database["public"]["Enums"]["cycle_status"]
        }
        Insert: {
          client_id: string
          completed_at?: string | null
          id?: string
          notes?: string | null
          period: string
          rank_summary?: Json | null
          report_url?: string | null
          status?: Database["public"]["Enums"]["cycle_status"]
        }
        Update: {
          client_id?: string
          completed_at?: string | null
          id?: string
          notes?: string | null
          period?: string
          rank_summary?: Json | null
          report_url?: string | null
          status?: Database["public"]["Enums"]["cycle_status"]
        }
        Relationships: [
          {
            foreignKeyName: "monthly_cycles_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          amount: number
          client_id: string
          id: string
          method: Database["public"]["Enums"]["payment_method"] | null
          notes: string | null
          paid_at: string | null
          period_end: string | null
          period_start: string | null
          recorded_by: string | null
          reference: string | null
          source: Database["public"]["Enums"]["payment_source"]
          stripe_invoice_id: string | null
          stripe_payment_intent_id: string | null
          subscription_id: string | null
        }
        Insert: {
          amount: number
          client_id: string
          id?: string
          method?: Database["public"]["Enums"]["payment_method"] | null
          notes?: string | null
          paid_at?: string | null
          period_end?: string | null
          period_start?: string | null
          recorded_by?: string | null
          reference?: string | null
          source?: Database["public"]["Enums"]["payment_source"]
          stripe_invoice_id?: string | null
          stripe_payment_intent_id?: string | null
          subscription_id?: string | null
        }
        Update: {
          amount?: number
          client_id?: string
          id?: string
          method?: Database["public"]["Enums"]["payment_method"] | null
          notes?: string | null
          paid_at?: string | null
          period_end?: string | null
          period_start?: string | null
          recorded_by?: string | null
          reference?: string | null
          source?: Database["public"]["Enums"]["payment_source"]
          stripe_invoice_id?: string | null
          stripe_payment_intent_id?: string | null
          subscription_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payments_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_subscription_id_fkey"
            columns: ["subscription_id"]
            isOneToOne: false
            referencedRelation: "subscriptions"
            referencedColumns: ["id"]
          },
        ]
      }
      pipelines: {
        Row: {
          id: string
          is_recurring: boolean
          key: Database["public"]["Enums"]["pipeline_key"]
          name: string
          sort_order: number
        }
        Insert: {
          id?: string
          is_recurring?: boolean
          key: Database["public"]["Enums"]["pipeline_key"]
          name: string
          sort_order?: number
        }
        Update: {
          id?: string
          is_recurring?: boolean
          key?: Database["public"]["Enums"]["pipeline_key"]
          name?: string
          sort_order?: number
        }
        Relationships: []
      }
      plans: {
        Row: {
          ad_budget_managed: number | null
          blog_posts_per_month: number | null
          client_id: string
          gbp_posts_per_month: number | null
          id: string
          monthly_fee: number | null
          notes: string | null
          package_name: string | null
          renewal_date: string | null
          social_posts_per_month: number | null
          start_date: string | null
          term_months: number | null
        }
        Insert: {
          ad_budget_managed?: number | null
          blog_posts_per_month?: number | null
          client_id: string
          gbp_posts_per_month?: number | null
          id?: string
          monthly_fee?: number | null
          notes?: string | null
          package_name?: string | null
          renewal_date?: string | null
          social_posts_per_month?: number | null
          start_date?: string | null
          term_months?: number | null
        }
        Update: {
          ad_budget_managed?: number | null
          blog_posts_per_month?: number | null
          client_id?: string
          gbp_posts_per_month?: number | null
          id?: string
          monthly_fee?: number | null
          notes?: string | null
          package_name?: string | null
          renewal_date?: string | null
          social_posts_per_month?: number | null
          start_date?: string | null
          term_months?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "plans_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: true
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      rank_runs: {
        Row: {
          checks_count: number | null
          client_id: string
          completed_at: string | null
          error: string | null
          id: string
          started_at: string
          status: Database["public"]["Enums"]["run_status"]
          triggered_by: Database["public"]["Enums"]["run_trigger"]
        }
        Insert: {
          checks_count?: number | null
          client_id: string
          completed_at?: string | null
          error?: string | null
          id?: string
          started_at?: string
          status?: Database["public"]["Enums"]["run_status"]
          triggered_by?: Database["public"]["Enums"]["run_trigger"]
        }
        Update: {
          checks_count?: number | null
          client_id?: string
          completed_at?: string | null
          error?: string | null
          id?: string
          started_at?: string
          status?: Database["public"]["Enums"]["run_status"]
          triggered_by?: Database["public"]["Enums"]["run_trigger"]
        }
        Relationships: [
          {
            foreignKeyName: "rank_runs_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      rank_snapshots: {
        Row: {
          id: string
          keyword_id: string
          location_id: string
          position: number | null
          recorded_at: string
          result_type: Database["public"]["Enums"]["rank_result_type"]
          run_id: string | null
          source: Database["public"]["Enums"]["rank_source"]
          url_ranked: string | null
        }
        Insert: {
          id?: string
          keyword_id: string
          location_id: string
          position?: number | null
          recorded_at?: string
          result_type: Database["public"]["Enums"]["rank_result_type"]
          run_id?: string | null
          source?: Database["public"]["Enums"]["rank_source"]
          url_ranked?: string | null
        }
        Update: {
          id?: string
          keyword_id?: string
          location_id?: string
          position?: number | null
          recorded_at?: string
          result_type?: Database["public"]["Enums"]["rank_result_type"]
          run_id?: string | null
          source?: Database["public"]["Enums"]["rank_source"]
          url_ranked?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "rank_snapshots_keyword_id_fkey"
            columns: ["keyword_id"]
            isOneToOne: false
            referencedRelation: "keywords"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rank_snapshots_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rank_snapshots_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "rank_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      social_accounts: {
        Row: {
          access_token: string | null
          client_id: string
          connected_at: string | null
          display_name: string | null
          external_account_id: string | null
          id: string
          platform: Database["public"]["Enums"]["social_platform"]
          status: Database["public"]["Enums"]["social_account_status"]
          token_expires_at: string | null
        }
        Insert: {
          access_token?: string | null
          client_id: string
          connected_at?: string | null
          display_name?: string | null
          external_account_id?: string | null
          id?: string
          platform: Database["public"]["Enums"]["social_platform"]
          status?: Database["public"]["Enums"]["social_account_status"]
          token_expires_at?: string | null
        }
        Update: {
          access_token?: string | null
          client_id?: string
          connected_at?: string | null
          display_name?: string | null
          external_account_id?: string | null
          id?: string
          platform?: Database["public"]["Enums"]["social_platform"]
          status?: Database["public"]["Enums"]["social_account_status"]
          token_expires_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "social_accounts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      social_posts: {
        Row: {
          asset_url: string | null
          client_id: string
          copy: string | null
          error: string | null
          external_post_id: string | null
          id: string
          notes: string | null
          platform: Database["public"]["Enums"]["social_platform"]
          published_url: string | null
          scheduled_at: string | null
          social_account_id: string | null
          status: Database["public"]["Enums"]["social_post_status"]
          storage_path: string | null
        }
        Insert: {
          asset_url?: string | null
          client_id: string
          copy?: string | null
          error?: string | null
          external_post_id?: string | null
          id?: string
          notes?: string | null
          platform: Database["public"]["Enums"]["social_platform"]
          published_url?: string | null
          scheduled_at?: string | null
          social_account_id?: string | null
          status?: Database["public"]["Enums"]["social_post_status"]
          storage_path?: string | null
        }
        Update: {
          asset_url?: string | null
          client_id?: string
          copy?: string | null
          error?: string | null
          external_post_id?: string | null
          id?: string
          notes?: string | null
          platform?: Database["public"]["Enums"]["social_platform"]
          published_url?: string | null
          scheduled_at?: string | null
          social_account_id?: string | null
          status?: Database["public"]["Enums"]["social_post_status"]
          storage_path?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "social_posts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_posts_social_account_id_fkey"
            columns: ["social_account_id"]
            isOneToOne: false
            referencedRelation: "social_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      stages: {
        Row: {
          default_owner: Database["public"]["Enums"]["owner_type"]
          description: string | null
          id: string
          is_optional: boolean
          name: string
          pipeline_id: string
          sort_order: number
        }
        Insert: {
          default_owner?: Database["public"]["Enums"]["owner_type"]
          description?: string | null
          id?: string
          is_optional?: boolean
          name: string
          pipeline_id: string
          sort_order?: number
        }
        Update: {
          default_owner?: Database["public"]["Enums"]["owner_type"]
          description?: string | null
          id?: string
          is_optional?: boolean
          name?: string
          pipeline_id?: string
          sort_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "stages_pipeline_id_fkey"
            columns: ["pipeline_id"]
            isOneToOne: false
            referencedRelation: "pipelines"
            referencedColumns: ["id"]
          },
        ]
      }
      stripe_customers: {
        Row: {
          client_id: string
          created_at: string
          id: string
          last4: string | null
          payment_method_type:
            | Database["public"]["Enums"]["payment_method_type"]
            | null
          stripe_customer_id: string
        }
        Insert: {
          client_id: string
          created_at?: string
          id?: string
          last4?: string | null
          payment_method_type?:
            | Database["public"]["Enums"]["payment_method_type"]
            | null
          stripe_customer_id: string
        }
        Update: {
          client_id?: string
          created_at?: string
          id?: string
          last4?: string | null
          payment_method_type?:
            | Database["public"]["Enums"]["payment_method_type"]
            | null
          stripe_customer_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "stripe_customers_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: true
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      subscriptions: {
        Row: {
          amount: number | null
          cancel_at: string | null
          client_id: string
          created_at: string
          current_period_end: string | null
          current_period_start: string | null
          id: string
          interval: string
          paid_status: Database["public"]["Enums"]["paid_status_type"]
          status: string | null
          stripe_price_id: string | null
          stripe_subscription_id: string | null
        }
        Insert: {
          amount?: number | null
          cancel_at?: string | null
          client_id: string
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          id?: string
          interval?: string
          paid_status?: Database["public"]["Enums"]["paid_status_type"]
          status?: string | null
          stripe_price_id?: string | null
          stripe_subscription_id?: string | null
        }
        Update: {
          amount?: number | null
          cancel_at?: string | null
          client_id?: string
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          id?: string
          interval?: string
          paid_status?: Database["public"]["Enums"]["paid_status_type"]
          status?: string | null
          stripe_price_id?: string | null
          stripe_subscription_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "subscriptions_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      task_templates: {
        Row: {
          default_owner: Database["public"]["Enums"]["owner_type"]
          department: Database["public"]["Enums"]["department"] | null
          id: string
          pipeline_id: string | null
          sort_order: number
          stage_id: string | null
          title: string
        }
        Insert: {
          default_owner?: Database["public"]["Enums"]["owner_type"]
          department?: Database["public"]["Enums"]["department"] | null
          id?: string
          pipeline_id?: string | null
          sort_order?: number
          stage_id?: string | null
          title: string
        }
        Update: {
          default_owner?: Database["public"]["Enums"]["owner_type"]
          department?: Database["public"]["Enums"]["department"] | null
          id?: string
          pipeline_id?: string | null
          sort_order?: number
          stage_id?: string | null
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_templates_pipeline_id_fkey"
            columns: ["pipeline_id"]
            isOneToOne: false
            referencedRelation: "pipelines"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_templates_stage_id_fkey"
            columns: ["stage_id"]
            isOneToOne: false
            referencedRelation: "stages"
            referencedColumns: ["id"]
          },
        ]
      }
      tasks: {
        Row: {
          client_id: string
          client_stage_id: string | null
          completed_at: string | null
          created_at: string
          due_date: string | null
          id: string
          monthly_cycle_id: string | null
          notes: string | null
          owner: Database["public"]["Enums"]["owner_type"]
          status: Database["public"]["Enums"]["task_status"]
          title: string
        }
        Insert: {
          client_id: string
          client_stage_id?: string | null
          completed_at?: string | null
          created_at?: string
          due_date?: string | null
          id?: string
          monthly_cycle_id?: string | null
          notes?: string | null
          owner?: Database["public"]["Enums"]["owner_type"]
          status?: Database["public"]["Enums"]["task_status"]
          title: string
        }
        Update: {
          client_id?: string
          client_stage_id?: string | null
          completed_at?: string | null
          created_at?: string
          due_date?: string | null
          id?: string
          monthly_cycle_id?: string | null
          notes?: string | null
          owner?: Database["public"]["Enums"]["owner_type"]
          status?: Database["public"]["Enums"]["task_status"]
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "tasks_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_client_stage_id_fkey"
            columns: ["client_stage_id"]
            isOneToOne: false
            referencedRelation: "client_stages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_monthly_cycle_id_fkey"
            columns: ["monthly_cycle_id"]
            isOneToOne: false
            referencedRelation: "monthly_cycles"
            referencedColumns: ["id"]
          },
        ]
      }
      team_members: {
        Row: {
          auth_user_id: string | null
          email: string
          id: string
          name: string
          role: Database["public"]["Enums"]["team_role"]
        }
        Insert: {
          auth_user_id?: string | null
          email: string
          id?: string
          name: string
          role?: Database["public"]["Enums"]["team_role"]
        }
        Update: {
          auth_user_id?: string | null
          email?: string
          id?: string
          name?: string
          role?: Database["public"]["Enums"]["team_role"]
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      create_monthly_cycles: { Args: { p_period?: string }; Returns: number }
    }
    Enums: {
      access_status: "not_needed" | "requested" | "granted"
      access_system:
        | "gsc"
        | "ga4"
        | "gbp"
        | "hosting"
        | "dns"
        | "meta_ads"
        | "google_ads"
        | "facebook"
        | "instagram"
        | "linkedin"
        | "tiktok"
        | "crm"
        | "other"
      client_status: "launching" | "active" | "paused" | "offboarded"
      content_status: "idea" | "brief" | "draft" | "review" | "published"
      cycle_status: "open" | "complete"
      deliverable_type: "drive" | "site" | "sheet" | "report" | "other"
      department: "seo" | "website" | "social" | "paid_ads"
      document_category:
        | "contract"
        | "proposal"
        | "brand"
        | "audit"
        | "report"
        | "other"
      document_kind: "drive_link" | "upload"
      enrollment_status: "active" | "complete" | "paused"
      keyword_priority: "p1" | "p2" | "p3"
      owner_type: "TOM" | "CLAUDE" | "CLAUDE_APPROVAL" | "DELEGATED" | "WAITING"
      paid_status_type: "paid" | "processing" | "open" | "past_due"
      payment_method: "card" | "stripe_ach" | "external_ach" | "check"
      payment_method_type: "card" | "us_bank_account" | "external_ach"
      payment_source: "stripe" | "manual"
      pipeline_key:
        | "seo"
        | "website"
        | "social"
        | "crm"
        | "paid_ads"
        | "reporting"
      rank_result_type: "organic" | "map_pack"
      rank_source: "brightlocal_report" | "brightlocal_live" | "csv" | "manual"
      run_status: "pending" | "running" | "complete" | "failed"
      run_trigger: "cron" | "manual"
      social_account_status: "connected" | "expired" | "manual_only"
      social_platform: "facebook" | "instagram" | "linkedin" | "x" | "tiktok"
      social_post_status:
        | "idea"
        | "drafted"
        | "approved"
        | "scheduled"
        | "published"
        | "failed"
      stage_status:
        | "not_started"
        | "in_progress"
        | "blocked"
        | "skipped"
        | "complete"
      task_status: "open" | "in_progress" | "blocked" | "done"
      team_role: "admin" | "member"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      access_status: ["not_needed", "requested", "granted"],
      access_system: [
        "gsc",
        "ga4",
        "gbp",
        "hosting",
        "dns",
        "meta_ads",
        "google_ads",
        "facebook",
        "instagram",
        "linkedin",
        "tiktok",
        "crm",
        "other",
      ],
      client_status: ["launching", "active", "paused", "offboarded"],
      content_status: ["idea", "brief", "draft", "review", "published"],
      cycle_status: ["open", "complete"],
      deliverable_type: ["drive", "site", "sheet", "report", "other"],
      department: ["seo", "website", "social", "paid_ads"],
      document_category: [
        "contract",
        "proposal",
        "brand",
        "audit",
        "report",
        "other",
      ],
      document_kind: ["drive_link", "upload"],
      enrollment_status: ["active", "complete", "paused"],
      keyword_priority: ["p1", "p2", "p3"],
      owner_type: ["TOM", "CLAUDE", "CLAUDE_APPROVAL", "DELEGATED", "WAITING"],
      paid_status_type: ["paid", "processing", "open", "past_due"],
      payment_method: ["card", "stripe_ach", "external_ach", "check"],
      payment_method_type: ["card", "us_bank_account", "external_ach"],
      payment_source: ["stripe", "manual"],
      pipeline_key: [
        "seo",
        "website",
        "social",
        "crm",
        "paid_ads",
        "reporting",
      ],
      rank_result_type: ["organic", "map_pack"],
      rank_source: ["brightlocal_report", "brightlocal_live", "csv", "manual"],
      run_status: ["pending", "running", "complete", "failed"],
      run_trigger: ["cron", "manual"],
      social_account_status: ["connected", "expired", "manual_only"],
      social_platform: ["facebook", "instagram", "linkedin", "x", "tiktok"],
      social_post_status: [
        "idea",
        "drafted",
        "approved",
        "scheduled",
        "published",
        "failed",
      ],
      stage_status: [
        "not_started",
        "in_progress",
        "blocked",
        "skipped",
        "complete",
      ],
      task_status: ["open", "in_progress", "blocked", "done"],
      team_role: ["admin", "member"],
    },
  },
} as const
